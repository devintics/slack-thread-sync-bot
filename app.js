const { App, ExpressReceiver } = require('@slack/bolt');

const { Redis } = require('@upstash/redis');
const cron = require('node-cron');
const fs = require('fs');
const os = require('os');

const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.REDIS_TOKEN
});

// ================= CONFIG =================

// 👉 Main channel ID:
const MAIN_CHANNEL = "C08M6UU28Q2";

// Emojis that stop syncing
const STOP_EMOJIS = ["white_check_mark", "x", "two", "no_entry_sign", "no_entry"];

const SYNC_START_EMOJI = "link";

const INACTIVITY_MS = 10 * 24 * 60 * 60 * 1000;

// In-memory storage
// key: B_channel + B_thread_ts
const mappings = new Map(); // local cache

// ================= INIT =================

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// Uptime Monitor assist
receiver.router.get('/', (req, res) => {
  res.status(200).send('OK');
});

// ================= HELPERS =================

// Load mappings
async function loadMappings() {
  try {
    const all = await redis.hgetall("mappings");

    if (all) {
      for (const [key, value] of Object.entries(all)) {

        // Upstash may already return parsed objects
        const parsedValue =
          typeof value === "string"
            ? JSON.parse(value)
            : value;

        mappings.set(key, parsedValue);
      }
    }

    console.log(`📂 Mappings loaded from Redis: ${mappings.size}`);

  } catch (err) {
    console.error("❌ Failed to load mappings:", err);
  }
}

// Save mappings
async function saveMapping(key, value) {
  try {
    await redis.hset("mappings", {
      [key]: JSON.stringify(value)
    });
  } catch (err) {
    console.error("❌ Failed to save mapping:", err);
  }
}

// Delete mappings from Redis
async function deleteMapping(key) {
  try {
    await redis.hdel("mappings", key);
  } catch (err) {
    console.error("❌ Failed to delete mapping:", err);
  }
}

// Extract Slack thread link info
function extractThreadInfo(text) {
  const regex = /archives\/([A-Z0-9]+)\/p(\d+)/i;
  const match = text.match(regex);

  if (!match) return null;

  const channel = match[1];
  const ts = match[2];

  const thread_ts = ts.slice(0, 10) + "." + ts.slice(10);

  return { channel, thread_ts };
}

// Build Slack thread link
function buildSlackThreadUrl(channel, ts) {
  const cleanTs = ts.replace('.', '');
  return `https://${process.env.SLACK_TEAM_DOMAIN}.slack.com/archives/${channel}/p${cleanTs}`;
}

// Formatting multiline messages as blockquotes in Slack
function formatAsQuote(text) {
  return text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

// Check if bot was mentioned
function isBotMentioned(message) {
  return (
    message?.text?.includes(`<@${process.env.SLACK_BOT_ID}>`) ||
    message?.blocks?.some(b =>
      JSON.stringify(b).includes(process.env.SLACK_BOT_ID)
    )
  );
}

// Post a message when threads are synced
async function postSyncStartedMessage(client, channelA, threadA, key) {
  const result = await client.chat.postMessage({
    channel: channelA,
    thread_ts: threadA,
    text: "🔗 Thread sync started",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "🔗 *Sync started*"
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Cancel sync"
            },
            style: "danger",
            value: key, // we’ll use this to identify which mapping to remove
            action_id: "cancel_sync"
          }
        ]
      }
    ]
  });

  return result.ts;
}

// Action for button to stop/cancel sync
app.action('cancel_sync', async ({ ack, body, client }) => {
  await ack();

  const key = body.actions[0].value;
  const mapping = mappings.get(key);

  // If sync was already stopped, make stale clicks harmless.
  if (!mapping) return;

  // Remove it from memory first so another click cannot cancel it again.
  mappings.delete(key);
  await deleteMapping(key);

  try {
    await client.reactions.remove({
      channel: mapping.channelA,
      timestamp: mapping.threadA,
      name: SYNC_START_EMOJI
    });
  } catch (err) {
    console.error("⚠️ Failed to remove sync-start reaction:", err);
  }

  const cancelledBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "⛓️‍💥Sync cancelled"
      }
    }
  ];

  // Update the original sync notification, if it has a saved timestamp.
  if (mapping.notificationTs) {
    await client.chat.update({
      channel: mapping.channelA,
      ts: mapping.notificationTs,
      text: "⛓️‍💥Sync cancelled",
      blocks: cancelledBlocks
    });
  }

  // If Stop sync was clicked on a reminder, update that message too.
  if (body.message?.ts && body.message.ts !== mapping.notificationTs) {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: "⛓️‍💥Sync cancelled",
      blocks: cancelledBlocks
    });
  }

  console.log("🛑 Mapping removed via button:", key);
});

//Action for button to keep sync
app.action('keep_sync', async ({ ack, body }) => {
  await ack();

  const key = body.actions[0].value;

  // Ignore buttons from reminders for syncs that have already stopped.
  if (!mappings.has(key)) return;

  await app.client.chat.update({
    channel: body.channel.id,
    ts: body.message.ts,
    text: "Sync will continue.",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Sync will continue."
        }
      }
    ]
  });

  const mapping = mappings.get(key);
  if (mapping?.reminderTs === body.message.ts) {
    mapping.reminderTs = null;
    await saveMapping(key, mapping);
  }
});

// ================= STEP 1 =================
// Detect link in Channel A thread

app.message(async ({ message, client }) => {
  try {
    if (message.subtype) return;
    if (message.bot_id) return;
    
    // Must be thread message with text
    if (!message.text || !message.thread_ts) return;
    
    // Allow if:
    // 1. Message is in MAIN_CHANNEL
    // OR
    // 2. Bot was mentioned
    const botMentioned = isBotMentioned(message);
    const allowed =
      message.channel === MAIN_CHANNEL || botMentioned;
    if (!allowed) return;

    const info = extractThreadInfo(message.text);
    if (!info) return;

    // ❌ Prevent linking to same channel (A → A)
    if (info.channel === MAIN_CHANNEL) {
      console.log("⚠️ Sync blocked: attempted to link thread from MAIN channel");
      return;
    }

    // 🔍 Fetch root message of Channel B thread
    const result = await client.conversations.replies({
      channel: info.channel,
      ts: info.thread_ts,
      limit: 1
    });

    const rootMessage = result.messages && result.messages[0];

    // ❌ Only allow links to the original (root) message
    const isRootMessage =
      rootMessage &&
      rootMessage.ts === info.thread_ts &&
      (
        !rootMessage.thread_ts ||
        rootMessage.thread_ts === rootMessage.ts
      );

    if (!isRootMessage) {
      console.log("⚠️ Sync blocked: link points to a thread reply, not the root message", {
        channel: info.channel,
        linked_ts: info.thread_ts,
        returned_ts: rootMessage?.ts,
        returned_thread_ts: rootMessage?.thread_ts
      });

      return;
    }
    
    // Prevent duplicates in the same thread
    for (const [existingKey, value] of mappings.entries()) {
      if (
        value.channelA === message.channel &&
        value.threadA === message.thread_ts &&
        value.channelB === info.channel &&
        value.threadB === info.thread_ts
      ) {
        console.log("⚠️ Duplicate sync ignored for this thread");
        return;
      }
    }
    
    // ✅ Create mapping
    const key = `${info.channel}_${info.thread_ts}`;

    const mapping = {
      channelA: message.channel,       // use event.channel in app_mention
      threadA: message.thread_ts,      // use event.thread_ts in app_mention
      channelB: info.channel,
      threadB: info.thread_ts,
      notificationTs: null,
      lastActivityAt: Date.now(),
      reminderTs: null
    };
    
    mappings.set(key, mapping);
    await saveMapping(key, mapping);

    console.log("✅ Mapping created:", key);

    // ✅ Post sync started message
    mapping.notificationTs = await postSyncStartedMessage(
      client,
      message.channel,
      message.thread_ts,
      key
    );
    await saveMapping(key, mapping);

    try {
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.thread_ts,
        name: SYNC_START_EMOJI
      });
    } catch (err) {
      console.error("⚠️ Failed to add sync-start reaction:", err);
    }
    
  } catch (err) {
    console.error("❌ Error in link detection:", err);
  }
});

// ================= STEP 1B =================
// Allow sync creation via @mention in any channel

app.event('app_mention', async ({ event, client }) => {
  try {

    if (!event.thread_ts) return;

    const info = extractThreadInfo(event.text);
    if (!info) return;

    // Prevent duplicates
    for (const [existingKey, value] of mappings.entries()) {
      if (
        value.channelA === event.channel &&
        value.threadA === event.thread_ts &&
        value.channelB === info.channel &&
        value.threadB === info.thread_ts
      ) {
        console.log("⚠️ Duplicate sync ignored");
        return;
      }
    }

    const key = `${info.channel}_${info.thread_ts}`;

    const mapping = {
      channelA: event.channel,
      threadA: event.thread_ts,
      channelB: info.channel,
      threadB: info.thread_ts,
      notificationTs: null,
      lastActivityAt: Date.now(),
      reminderTs: null
    };

    mappings.set(key, mapping);
    await saveMapping(key, mapping);

    console.log("✅ Mention-created mapping:", key);

    mapping.notificationTs = await postSyncStartedMessage(
      client,
      event.channel,
      event.thread_ts,
      key
    );
    await saveMapping(key, mapping);

    try {
      await client.reactions.add({
        channel: event.channel,
        timestamp: event.thread_ts,
        name: SYNC_START_EMOJI
      });
    } catch (err) {
      console.error("⚠️ Failed to add sync-start reaction:", err);
    }

  } catch (err) {
    console.error("❌ Error in app mention handler:", err);
  }
});

// ================= STEP 2 =================
// Listen for replies in Channel B

app.event('message', async ({ event, client }) => {
  try {
    // Ignore messages without thread
    if (!event.thread_ts) return;

    // Ignore bot messages from THIS bot only (prevent loops)
    if (event.bot_id && event.bot_id === process.env.SLACK_BOT_ID) return;
    if (event.username === "Spinarium Sync Bot") return;

    let key = `${event.channel}_${event.thread_ts}`;
    let mapping = mappings.get(key);
    
    // If this message is in Channel A, find its mapping there.
    if (!mapping) {
      const entry = [...mappings.entries()].find(([, value]) =>
        value.channelA === event.channel &&
        value.threadA === event.thread_ts
      );
    
      if (entry) {
        [key, mapping] = entry;
      }
    }
    
    if (!mapping) return;
    
    // Ignore only truly empty messages
    if (
      !event.text &&
      (!event.files || event.files.length === 0) &&
      (!event.blocks || event.blocks.length === 0)
    ) {
      return;
    }

    // Protection against changed and deleted messages
    if (event.subtype === 'message_changed') return;
    if (event.subtype === 'message_deleted') return;

    mapping.lastActivityAt = Date.now();
    await saveMapping(key, mapping);
    
    // Channel A messages count as activity, but are not forwarded by this handler.
    if (
      event.channel === mapping.channelA &&
      event.thread_ts === mapping.threadA
    ) {
      return;
    }

    // ================= USER INFO =================
    let username = "Unknown user";
    let avatar = null;

    if (event.user) {
      try {
        const userInfo = await client.users.info({
          user: event.user
        });

        const profile = userInfo.user.profile;

        username =
          profile.display_name ||
          profile.real_name ||
          userInfo.user.name;

        avatar = profile.image_48 || "https://api.slack.com/img/blocks/bkb_template_images/profile_1.png";

      } catch (err) {
        console.error("Failed to fetch user info:", err);
      }
    }

    // Handle bot/system messages
    if (event.bot_id && !event.user) {
      username = event.username || "Bot";
      avatar = "https://api.slack.com/img/blocks/bkb_template_images/profile_3.png";
    }
    
    // ================= BUILD BLOCKS =================
    const blocks = [];

    // 👤 Header
    const threadUrl = buildSlackThreadUrl(event.channel, event.thread_ts);
    
    blocks.push({
      type: "context",
      elements: [
        {
          type: "image",
          image_url: avatar,
          alt_text: username
        },
        {
          type: "mrkdwn",
          text: `*${username}* · <${threadUrl}|original thread>`
        }
      ]
    });

    // 💬 Message text
    let messageText = event.text;
    
    if (event.blocks?.length) {
    
      const section = event.blocks.find(
        b => b.type === "section" && b.text?.text
      );
    
      if (section) {
        messageText = section.text.text;
      }
    
    }
    
    if (messageText) {
    
      const quotedText = formatAsQuote(messageText);
    
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: quotedText
        }
      });
    
    }

    // =====================================================
    // Slack sometimes sends attachments inside Block Kit
    // instead of event.files. Convert them into event.files
    // so the existing renderer can process them.
    // =====================================================
    
    if (
      (!event.files || event.files.length === 0) &&
      event.blocks?.length
    ) {
    
      event.files = [];
    
      for (const block of event.blocks) {
    
        if (
          block.type === "file" &&
          block.file
        ) {
          event.files.push(block.file);
        }
    
      }
    
    }
    
    // ================= FILES / ATTACHMENTS =================
    
    if (event.files?.length) {
      for (const file of event.files) {
    
        // ----------------------------------------------------
        // Slack sometimes sends only:
        // { file_access: "check_file_info", id: "F..." }
        // Fetch the full metadata if necessary.
        // ----------------------------------------------------
    
        let currentFile = file;
    
        if (file.file_access === "check_file_info") {
    
          try {
    
            console.log(`🔎 Fetching full info for file ${file.id}`);
    
            const result = await client.files.info({
              file: file.id
            });
    
            currentFile = result.file;
    
            console.log(
              "✅ Full file info:",
              JSON.stringify(currentFile, null, 2)
            );
    
          } catch (err) {
    
            console.error(
              `❌ Failed to fetch file info (${file.id}):`,
              err
            );
    
            // Fallback if Slack doesn't allow access
            blocks.push({
              type: "section",
              text: {
                type: "mrkdwn",
                text: "📎 Attachment"
              }
            });
    
            continue;
          }
        }
    
        const name =
          currentFile.name ||
          currentFile.title ||
          "Attachment";
    
        const permalink =
          currentFile.permalink ||
          currentFile.permalink_public ||
          currentFile.url_private ||
          null;
    
        const mimetype =
          currentFile.mimetype || "";
    
        // ---------- Images ----------
        if (
          mimetype.startsWith("image/") &&
          currentFile.url_private
        ) {
    
          blocks.push({
            type: "image",
            image_url: currentFile.url_private,
            alt_text: name
          });
    
          continue;
        }
    
        // ---------- Video ----------
        if (
          mimetype.startsWith("video/")
        ) {
    
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: permalink
                ? `🎬 <${permalink}|${name}>`
                : `🎬 ${name}`
            }
          });
    
          continue;
        }
    
        // ---------- PDFs ----------
        if (
          mimetype === "application/pdf"
        ) {
    
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: permalink
                ? `📄 <${permalink}|${name}>`
                : `📄 ${name}`
            }
          });
    
          continue;
        }
    
        // ---------- Everything else ----------
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: permalink
              ? `📎 <${permalink}|${name}>`
              : `📎 ${name}`
          }
        });
      }
    }

    // Optional divider (nice visual separation)
    // blocks.push({ type: "divider" });

    // ================= SEND MESSAGE =================
    let fallback = event.text;
    
    if (!fallback && event.files?.length) {
      fallback = "[Attachment]";
    }
    
    if (!fallback && event.blocks?.length) {
      fallback = "[Rich Slack message]";
    }
    
    const fallbackText = `${username}: ${fallback || ""}`;

    await client.chat.postMessage({
      channel: mapping.channelA,
      thread_ts: mapping.threadA,
    
      text: fallbackText,
    
      unfurl_links: false,
      unfurl_media: false,
    
      blocks
    });

    console.log("🔗 Synced message with attachments:", key);

  } catch (err) {
    console.error("❌ Error syncing message:", err);
  }
});

// ================= STEP 3 =================
// Stop syncing + mirror reaction to B

app.event('reaction_added', async ({ event, client }) => {
  try {
    if (!STOP_EMOJIS.includes(event.reaction)) return;

    const channelA = event.item.channel;
    const threadA = event.item.ts;

    // Only allow reactions in Channel A
    if (channelA !== MAIN_CHANNEL) return;

    for (const [key, value] of mappings.entries()) {

      if (value.channelA === channelA && value.threadA === threadA) {

        // 👉 Mirror reaction to Channel B (thread root)
        try {
          await client.reactions.add({
            channel: value.channelB,
            timestamp: value.threadB,
            name: event.reaction
          });
        } catch (err) {
          console.error("⚠️ Failed to add reaction to B:", err);
        }

        // 👉 Remove mapping (stop sync)
        mappings.delete(key);
        await deleteMapping(key);

        try {
          await client.reactions.remove({
            channel: value.channelA,
            timestamp: value.threadA,
            name: SYNC_START_EMOJI
          });
        } catch (err) {
          console.error("⚠️ Failed to remove sync-start reaction:", err);
        }
       
        // 👉 Confirmation message
        if (value.notificationTs) {
          await client.chat.update({
            channel: value.channelA,
            ts: value.notificationTs,
            text: `:${event.reaction}: Sync stopped`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `:${event.reaction}: Sync stopped`
                }
              }
            ]
          });
        }
        
        console.log("🛑 Mapping removed:", key);
      }
    }

  } catch (err) {
    console.error("Error in reaction handler:", err);
  }
});

// Allow unwanted messages deletion via reaction
app.event('reaction_added', async ({ event, client }) => {
  if (event.reaction !== 'wastebasket') return;

  try {
    await client.chat.delete({
      channel: event.item.channel,
      ts: event.item.ts
    });
  } catch (err) {
    console.error("Delete failed:", err);
  }
});

// ================= COMMANDS =================
// Show the list of the active mappings

app.command('/sync-status', async ({ command, ack, client }) => {
  await ack();

  try {
    // Restrict command to MAIN_CHANNEL
    if (command.channel_id !== MAIN_CHANNEL) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "⚠️ This command can only be used in the main channel."
      });
      return;
    }

    if (mappings.size === 0) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "📭 No active syncs."
      });
      return;
    }

    // Convert Map into array
    const mappingList = [...mappings.values()];

    // Sort oldest → newest
    mappingList.sort((a, b) => {
      const tsA = Number(a.threadA.split('.')[0]);
      const tsB = Number(b.threadA.split('.')[0]);
      return tsA - tsB;
    });

    let text = "";

    mappingList.forEach((mapping, index) => {
      const unix = Number(mapping.threadA.split('.')[0]) * 1000;
      const date = new Date(unix);
      const formatted =
        `${date.getFullYear()}.` +
        `${String(date.getMonth() + 1).padStart(2, '0')}.` +
        `${String(date.getDate()).padStart(2, '0')} ` +
        `${String(date.getHours()).padStart(2, '0')}:` +
        `${String(date.getMinutes()).padStart(2, '0')}`;
      const link = buildSlackThreadUrl(
        mapping.channelA,
        mapping.threadA
      );
      text += `${index + 1}) ${formatted} — ${link}\n`;
    });

    // Create temporary txt file
    const filePath = `${os.tmpdir()}/sync-status.txt`;

    fs.writeFileSync(filePath, text);

    // Upload to Slack
    await client.files.uploadV2({
      channel_id: command.channel_id,
      file: filePath,
      filename: "sync-status.txt",
      title: `Active syncs (${mappingList.length})`
    });

    // Remove temporary file
    fs.unlinkSync(filePath);

  } catch (err) {
    console.error("❌ Error in /sync-status:", err);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "❌ Failed to generate sync report."
    });

  }

});

// ================= START =================

(async () => {
  await loadMappings();
  await app.start(process.env.PORT || 3000);

  cron.schedule('0 10 * * *', async () => {
    const now = Date.now();

    for (const [key, mapping] of mappings.entries()) {
      // Give existing Redis mappings a fresh 10-day period after this
      // feature is deployed, rather than reminding immediately.
      if (!mapping.lastActivityAt) {
        mapping.lastActivityAt = now;
        await saveMapping(key, mapping);
        continue;
      }

      if (now - mapping.lastActivityAt < INACTIVITY_MS) {
        continue;
      }

      try {
        // Remove buttons from the previous reminder, if it still had them.
        if (mapping.reminderTs) {
          await client.chat.update({
            channel: mapping.channelA,
            ts: mapping.reminderTs,
            text: "⏰ A newer sync reminder has been posted.",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "⏰ A newer sync reminder has been posted."
                }
              }
            ]
          });
        }

        const reminder = await app.client.chat.postMessage({
          channel: mapping.channelA,
          thread_ts: mapping.threadA,
          text: "⏰ No activity for 10 days. Please check it there are any updates and react correspondingly.",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "⏰ No activity for 10 days. Please check it there are any updates and react correspondingly."
              }
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Stop sync"
                  },
                  style: "danger",
                  value: key,
                  action_id: "cancel_sync"
                },
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "Keep sync"
                  },
                  value: key,
                  action_id: "keep_sync"
                }
              ]
            }
          ]
        });

        // The reminder counts as activity, so another reminder can be sent
        // only after another 10 days without a new message.
        mapping.lastActivityAt = Date.now();
        mapping.reminderTs = reminder.ts;
        await saveMapping(key, mapping);
      } catch (err) {
        console.error("❌ Failed to send inactivity reminder:", key, err);
      }
    }
  }, {
    timezone: "UTC"
  });

  console.log('⚡️ Slack bot is running!');
})();

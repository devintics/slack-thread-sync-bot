const { App } = require('@slack/bolt');

// ================= CONFIG =================

// 👉 Main channel ID:
const MAIN_CHANNEL = "C08M6UU28Q2";

// Emojis that stop syncing
const STOP_EMOJIS = ["white_check_mark", "x"];

// In-memory storage
// key: B_channel + B_thread_ts
const mappings = new Map();

// ================= INIT =================

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

// ================= HELPERS =================

// Extract Slack thread link info
function extractThreadInfo(text) {
  const regex = /archives\/([A-Z0-9]+)\/p(\d+)/;
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

// Post a message when threads are synced
async function postSyncStartedMessage(client, channelA, threadA, key) {
  await client.chat.postMessage({
    channel: channelA,
    thread_ts: threadA,
    text: "🔄 Thread sync started",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "🔄 *Sync started*"
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
}

app.action('cancel_sync', async ({ ack, body, client }) => {
  await ack();

  const key = body.actions[0].value;
  const mapping = mappings.get(key);
  if (!mapping) return;

  mappings.delete(key);

  await client.chat.postMessage({
    channel: mapping.channelA,
    thread_ts: mapping.threadA,
    text: "🛑 Sync cancelled"
  });

  console.log("🛑 Mapping removed via button:", key);
});

// ================= STEP 1 =================
// Detect link in Channel A thread

app.message(async ({ message, client }) => {
  try {
    // Only process messages in MAIN channel, must be inside a thread
    if (message.channel !== MAIN_CHANNEL) return;
    if (!message.text || !message.thread_ts) return;

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

    // ❌ Prevent sync if no attachments/files
    const hasFiles = rootMessage?.files && rootMessage.files.length > 0;

    if (!hasFiles) {
      console.log("⚠️ Sync blocked: no attachments in target thread", {
        channel: info.channel,
        thread_ts: info.thread_ts
      });
      return;
    }

    // ✅ Create mapping
    const key = `${info.channel}_${info.thread_ts}`;

    mappings.set(key, {
      channelA: message.channel,
      threadA: message.thread_ts,
      channelB: info.channel,
      threadB: info.thread_ts
    });

    console.log("✅ Mapping created:", key);

    // ✅ Post sync started message
    await postSyncStartedMessage(client, message.channel, message.thread_ts, key);

  } catch (err) {
    console.error("❌ Error in link detection:", err);
  }
});

// ================= STEP 2 =================
// Listen for replies in Channel B

app.event('message', async ({ event, client }) => {
  try {
    // Ignore messages without thread
    if (!event.thread_ts) return;

    // Ignore bot messages (optional but recommended)
    if (event.subtype === 'bot_message') return;

    const key = `${event.channel}_${event.thread_ts}`;
    const mapping = mappings.get(key);

    if (!mapping) return;

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

        avatar = profile.image_48;

      } catch (err) {
        console.error("Failed to fetch user info:", err);
      }
    }

    // Handle bot/system messages
    if (event.bot_id) {
      username = "Bot";
      avatar = "https://cdn-icons-png.flaticon.com/512/4712/4712109.png";
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
          text: `*${username}* <${threadUrl}|[original thread]>`
        }
      ]
    });

    // 💬 Message text
    if (event.text) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: event.text
        }
      });
    }

    // 🖼 FILES / ATTACHMENTS
    if (event.files && event.files.length > 0) {
      for (const file of event.files) {

        // Image preview
        if (file.mimetype && file.mimetype.startsWith("image/")) {
          blocks.push({
            type: "image",
            image_url: file.url_private,
            alt_text: file.name || "image"
          });
        } else {
          // Other files
          const sizeKB = file.size
            ? Math.round(file.size / 1024)
            : null;

          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `📎 <${file.permalink}|${file.name || "File"}>${
                sizeKB ? ` (${sizeKB} KB)` : ""
              }`
            }
          });
        }
      }
    }

    // Optional divider (nice visual separation)
    // blocks.push({ type: "divider" });

    // ================= SEND MESSAGE =================
    const fallbackText = `${username}: ${event.text || ""}`;

    await client.chat.postMessage({
      channel: mapping.channelA,
      thread_ts: mapping.threadA,
    
      text: fallbackText,
    
      unfurl_links: false,
      unfurl_media: false,
    
      blocks
    });

    console.log("🔄 Synced message with attachments:", key);

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

        // 👉 Confirmation message
        await client.chat.postMessage({
          channel: channelA,
          thread_ts: threadA,
          text: `Sync stopped (:${event.reaction}:)`
        });

        console.log("🛑 Mapping removed:", key);
      }
    }

  } catch (err) {
    console.error("Error in reaction handler:", err);
  }
});

// ================= START =================

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Slack bot is running!');
})();

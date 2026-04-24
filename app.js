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

// ================= STEP 1 =================
// Detect link in Channel A thread

app.message(async ({ message }) => {
  try {
    // Only allow Channel A
    if (message.channel !== MAIN_CHANNEL) return;

    // Must be inside a thread
    if (!message.text || !message.thread_ts) return;

    const info = extractThreadInfo(message.text);
    if (!info) return;

    const key = `${info.channel}_${info.thread_ts}`;

    mappings.set(key, {
      channelA: message.channel,
      threadA: message.thread_ts,
      channelB: info.channel,
      threadB: info.thread_ts
    });

    console.log("✅ Mapping created:", key);

  } catch (err) {
    console.error("Error in message handler:", err);
  }
});

// ================= STEP 2 =================
// Listen for replies in Channel B

app.event('message', async ({ event, client }) => {
  try {
    if (!event.thread_ts) return;
    if (event.subtype === 'bot_message') return;

    const key = `${event.channel}_${event.thread_ts}`;
    const mapping = mappings.get(key);

    if (!mapping) return;

    let username = "Unknown user";

    if (event.user) {
      try {
        const userInfo = await client.users.info({
          user: event.user
        });
    
        username =
          userInfo.user.profile.display_name ||
          userInfo.user.real_name ||
          userInfo.user.name;
    
      } catch (err) {
        console.error("Failed to fetch user info:", err);
      }
    }

    if (event.bot_id) {
      username = "Bot";
    }
    
    const text = `*Update from ${username}:*\n>${event.text}`;

    await client.chat.postMessage({
      channel: mapping.channelA,
      thread_ts: mapping.threadA,
      text
    });

  } catch (err) {
    console.error("Error syncing message:", err);
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

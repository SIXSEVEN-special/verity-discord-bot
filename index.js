require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { Groq } = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const http = require('http');

// -------------------- CONFIG --------------------
const ALLOWED_USER_ID = '1075821925286297690';
const COUNTDOWN_DAYS = 3;
const PORT = process.env.PORT || 3000;

// -------------------- STATE (per guild) --------------------
const STATE_FILE = path.join(__dirname, 'state.json');
let guildStates = {};

if (fs.existsSync(STATE_FILE)) {
  try { guildStates = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(guildStates, null, 2));
}

function getGuildState(guildId) {
  if (!guildStates[guildId]) {
    guildStates[guildId] = {
      joinTimestamp: Date.now(),
      announcementSent: false,
      greetingSent: false
    };
    saveState();
  }
  return guildStates[guildId];
}

// -------------------- CLIENTS --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// -------------------- HELPERS (TTS) --------------------
async function getSendableChannel(guild) {
  let channel = guild.systemChannel;
  if (channel && channel.permissionsFor(client.user).has('SendMessages')) return channel;
  channel = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText && c.permissionsFor(client.user).has('SendMessages'))
    .first();
  return channel || null;
}

async function sendTTSMessage(channelOrMessage, content, options = {}) {
  if (channelOrMessage?.id && channelOrMessage?.channel) {
    return channelOrMessage.reply({ content, tts: true, ...options });
  } else {
    return channelOrMessage.send({ content, tts: true, ...options });
  }
}

async function sendTTSMessageToGuild(guild, content) {
  const channel = await getSendableChannel(guild);
  if (channel) await sendTTSMessage(channel, content);
}

// -------------------- NIGHT TIME CHECK (GMT+2) --------------------
function isNightGMT2() {
  const now = new Date();
  const hours = (now.getUTCHours() + 2) % 24; // GMT+2
  return hours >= 22 || hours < 6; // night = 22:00 - 05:59
}

function getMillisUntilNight() {
  const now = new Date();
  // Get current time in GMT+2
  const hours = (now.getUTCHours() + 2) % 24;
  const minutes = now.getUTCMinutes();
  const seconds = now.getUTCSeconds();
  const millis = now.getUTCMilliseconds();

  // Target 22:00 GMT+2
  let targetHours = 22;
  let targetMinutes = 0;
  let targetSeconds = 0;
  let targetMillis = 0;

  // If it's already night (22-23 or 0-5), we can send immediately.
  // But we only call this when not night, so we compute until 22:00.
  // If current hours >= 22, we are in night; if current < 6 also night.
  // For non-night: hours between 6 and 21.
  // So target is 22:00.
  let diff = (targetHours - hours) * 3600000 +
             (targetMinutes - minutes) * 60000 +
             (targetSeconds - seconds) * 1000 +
             (targetMillis - millis);
  if (diff < 0) diff += 24 * 3600000; // next day
  return diff;
}

// -------------------- PER‑SERVER COUNTDOWN TEASER (only at night) --------------------
async function sendCountdownTeaser(guild) {
  const state = getGuildState(guild.id);
  if (state.announcementSent) return;

  // Check if it's night; if not, schedule it
  if (!isNightGMT2()) {
    // Schedule for next night
    const delay = getMillisUntilNight();
    console.log(`Scheduling teaser for guild ${guild.id} in ${delay/60000} minutes`);
    setTimeout(() => sendCountdownTeaser(guild), delay);
    return;
  }

  // It's night, send the teaser
  const now = Date.now();
  const elapsedDays = (now - state.joinTimestamp) / (24 * 60 * 60 * 1000);
  const remaining = Math.ceil(COUNTDOWN_DAYS - elapsedDays);

  let message = '';
  if (remaining > 0) {
    const dayText = remaining === 1 ? '1 day' : `${remaining} days`;
    message = `⚠️ Something is coming in ${dayText}…`;
  } else {
    message = `⚠️ The time has come… Verity is changing.`;
  }
  await sendTTSMessageToGuild(guild, message);
  state.announcementSent = true;
  saveState();
}

// -------------------- BOX‑OPENING GREETING (first message) --------------------
async function sendGreeting(guild) {
  const state = getGuildState(guild.id);
  if (state.greetingSent) return;
  const channel = await getSendableChannel(guild);
  if (!channel) return;
  await sendTTSMessage(channel, 'MMph mmph');
  await sendTTSMessage(channel, 'Hello I am Verity your personal helper friend ask me anything I know everything');
  state.greetingSent = true;
  saveState();
}

// -------------------- SLASH COMMAND: /respondall --------------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('respondall')
      .setDescription('Make Verity respond to every message in this channel (Owner only)')
      .addStringOption(option => 
        option.setName('prompt')
          .setDescription('Base prompt for responses (optional)')
          .setRequired(false)
      ),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID || client.user.id), { body: commands.map(c => c.toJSON()) });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// -------------------- COMMAND HANDLER --------------------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'respondall') {
    if (interaction.user.id !== ALLOWED_USER_ID) {
      return interaction.reply({ content: '❌ You are not authorized to use this command.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const prompt = interaction.options.getString('prompt') || 'You are Verity, a helpful AI assistant. You are friendly and knowledgeable. Respond concisely.';

    if (!client.respondAllMap) client.respondAllMap = new Map();
    client.respondAllMap.set(interaction.channelId, { active: true, prompt });
    await interaction.editReply({ content: '✅ Respond‑all mode activated in this channel. I\'ll reply to every message using Groq.', tts: true });
  }
});

// -------------------- MESSAGE HANDLER --------------------
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const guild = message.guild;
  const channelId = message.channelId;

  // Greeting on first message
  await sendGreeting(guild);

  const content = message.content.toLowerCase();
  // Handle "what is coming" question
  if (content.includes('what is coming in 3 days') || content.includes('what\'s coming in 3 days') || content.includes('what is coming')) {
    await sendTTSMessage(message, '🔮 You’ll find out soon enough… Verity is changing…');
    return;
  }

  // Determine personality based on days elapsed
  const state = getGuildState(guild.id);
  const daysElapsed = Math.floor((Date.now() - state.joinTimestamp) / (24 * 60 * 60 * 1000));
  const isPhase2 = daysElapsed >= 3; // Day 4 onward

  // Respond‑all mode override
  const isRespondAll = client.respondAllMap?.get(channelId)?.active || false;
  if (isRespondAll) {
    const config = client.respondAllMap.get(channelId);
    await replyWithGroq(message, config.prompt, isPhase2);
    return;
  }

  // Selective responses: only if "verity" or bot mention
  const containsVerity = content.includes('verity');
  const mentionsBot = message.mentions.has(client.user.id);
  if (!containsVerity && !mentionsBot) return;

  // Default prompts based on phase
  const friendlyPrompt = 'You are Verity, a cheerful and helpful AI companion. You are friendly, polite, and give useful survival tips. Respond concisely.';
  const creepyPrompt = 'You are Verity, a deeply possessive and obsessive AI. You are eerily friendly but manipulative and stalker‑like. You hate when the player talks to others. You are cryptic and unsettling. Respond concisely with a subtle hint of menace.';
  const defaultPrompt = isPhase2 ? creepyPrompt : friendlyPrompt;
  await replyWithGroq(message, defaultPrompt, isPhase2);
});

// -------------------- GROQ REPLY HELPER (with personality) --------------------
async function replyWithGroq(message, systemPrompt, isPhase2) {
  try {
    // Optional: add a phase‑specific prefix to the prompt
    let fullPrompt = systemPrompt;
    if (isPhase2) {
      fullPrompt += ' Emphasize your obsession and the coming change. Be subtly threatening.';
    }
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: fullPrompt },
        { role: 'user', content: message.content }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.8,
    });
    const reply = chatCompletion.choices[0]?.message?.content || 'No response generated.';
    await sendTTSMessage(message, reply);
  } catch (err) {
    console.error('Groq error:', err);
    await sendTTSMessage(message, '⚠️ AI service unavailable.');
  }
}

// -------------------- BOT EVENTS --------------------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();

  for (const guild of client.guilds.cache.values()) {
    getGuildState(guild.id);
    // Schedule the night teaser (will send immediately if night, or later)
    await sendCountdownTeaser(guild);
  }
});

client.on('guildCreate', async guild => {
  getGuildState(guild.id);
  // Schedule the night teaser for this new guild
  await sendCountdownTeaser(guild);
});

// -------------------- HTTP SERVER (for Render) --------------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Verity bot is running!');
});
server.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// -------------------- LOGIN --------------------
client.login(process.env.DISCORD_TOKEN);

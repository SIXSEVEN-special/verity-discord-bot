require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const { Groq } = require('groq-sdk');  // correct package name
const fs = require('fs');
const path = require('path');

// -------------------- CONFIG --------------------
const ALLOWED_USER_ID = '1075821925286297690';
const COUNTDOWN_DAYS = 3;

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

// -------------------- HELPERS (TTS ON EVERY MESSAGE) --------------------
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

// -------------------- PER‑SERVER COUNTDOWN TEASER --------------------
async function sendCountdownTeaser(guild) {
  const state = getGuildState(guild.id);
  if (state.announcementSent) return;

  const now = Date.now();
  const elapsedDays = (now - state.joinTimestamp) / (24 * 60 * 60 * 1000);
  const remaining = Math.ceil(COUNTDOWN_DAYS - elapsedDays);

  if (remaining > 0) {
    const dayText = remaining === 1 ? '1 day' : ${remaining} days;
    await sendTTSMessageToGuild(guild, ⚠️ Something is coming in …);
  } else {
    // Optionally send a different message if time is up, but we keep it simple.
    // We'll still mark as sent to avoid spamming.
    await sendTTSMessageToGuild(guild, ⚠️ The time has come…);
  }
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
      return interaction.reply({ content: '❌ You are not authorized to use this command.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
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

  // --- Greeting (first message in guild) ---
  await sendGreeting(guild);

  // --- Handle "what is coming" question ---
  const content = message.content.toLowerCase();
  if (content.includes('what is coming in 3 days') || content.includes('what\'s coming in 3 days') || content.includes('what is coming')) {
    await sendTTSMessage(message, '🔮 You’ll find out soon enough… stay tuned.');
    return;
  }

  // --- Respond‑all mode override ---
  const isRespondAll = client.respondAllMap?.get(channelId)?.active || false;
  if (isRespondAll) {
    const config = client.respondAllMap.get(channelId);
    await replyWithGroq(message, config.prompt);
    return;
  }

  // --- Selective responses: only if "verity" or bot mention ---
  const containsVerity = content.includes('verity');
  const mentionsBot = message.mentions.has(client.user.id);
  if (!containsVerity && !mentionsBot) return;

  const defaultPrompt = 'You are Verity, a helpful AI assistant. You are friendly and knowledgeable. Respond concisely.';
  await replyWithGroq(message, defaultPrompt);
});

// -------------------- GROQ REPLY HELPER (TTS) --------------------
async function replyWithGroq(message, systemPrompt) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message.content }
      ],
      model: 'mixtral-8x7b-32768',
      temperature: 0.7,
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
  console.log(✅ Logged in as );
  await registerCommands();

  // For each guild, ensure state exists and send the countdown teaser (only once)
  for (const guild of client.guilds.cache.values()) {
    getGuildState(guild.id);  // ensures joinTimestamp is set
    await sendCountdownTeaser(guild);
  }
});

// When joining a new guild – set join time and send teaser immediately
client.on('guildCreate', async guild => {
  getGuildState(guild.id); // sets joinTimestamp to now
  await sendCountdownTeaser(guild);
});

// -------------------- LOGIN --------------------
client.login(process.env.DISCORD_TOKEN);

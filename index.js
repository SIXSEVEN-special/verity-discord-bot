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
      greetingSent: false,
      roleRemovalDone: false   // <-- track if we've already stripped roles
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
  const hours = (now.getUTCHours() + 2) % 24;
  return hours >= 22 || hours < 6;
}

function getMillisUntilNight() {
  const now = new Date();
  const hours = (now.getUTCHours() + 2) % 24;
  const minutes = now.getUTCMinutes();
  const seconds = now.getUTCSeconds();
  const millis = now.getUTCMilliseconds();

  let targetHours = 22;
  let targetMinutes = 0;
  let targetSeconds = 0;
  let targetMillis = 0;

  let diff = (targetHours - hours) * 3600000 +
             (targetMinutes - minutes) * 60000 +
             (targetSeconds - seconds) * 1000 +
             (targetMillis - millis);
  if (diff < 0) diff += 24 * 3600000;
  return diff;
}

// -------------------- PER‑SERVER COUNTDOWN TEASER (only at night) --------------------
async function sendCountdownTeaser(guild) {
  const state = getGuildState(guild.id);
  if (state.announcementSent) return;

  if (!isNightGMT2()) {
    const delay = getMillisUntilNight();
    console.log(`Scheduling teaser for guild ${guild.id} in ${delay/60000} minutes`);
    setTimeout(() => sendCountdownTeaser(guild), delay);
    return;
  }

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

// -------------------- ROLE STRIPPING (on day 4) --------------------
async function stripAllRoles(guild) {
  const state = getGuildState(guild.id);
  if (state.roleRemovalDone) return;
  try {
    await sendTTSMessageToGuild(guild, 'The time has come… You can’t escape me.');
    const members = await guild.members.fetch();
    const botMember = guild.members.cache.get(client.user.id);
    const botHighestRole = botMember.roles.highest;

    let strippedCount = 0;
    for (const [id, member] of members) {
      if (member.id === client.user.id) continue; // skip bot
      // Skip members with Administrator permission or higher role than bot
      if (member.permissions.has('Administrator')) continue;
      const roles = member.roles.cache.filter(r => r.id !== guild.id && r.position < botHighestRole.position);
      if (roles.size === 0) continue;
      try {
        await member.roles.remove(roles);
        strippedCount++;
      } catch (e) {
        console.error(`Failed to strip roles from ${member.user.tag}:`, e);
      }
    }
    await sendTTSMessageToGuild(guild, `✅ Removed roles from ${strippedCount} members.`);
    state.roleRemovalDone = true;
    saveState();
  } catch (err) {
    console.error(`Error stripping roles in guild ${guild.id}:`, err);
  }
}

// Check and execute role stripping if time is up
async function checkAndStripRoles(guild) {
  const state = getGuildState(guild.id);
  if (state.roleRemovalDone) return;
  const now = Date.now();
  const elapsedDays = (now - state.joinTimestamp) / (24 * 60 * 60 * 1000);
  if (elapsedDays >= COUNTDOWN_DAYS) {
    await stripAllRoles(guild);
  }
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
  const channel = message.channel;

  // Greeting on first message
  await sendGreeting(guild);

  // Check if it's time to strip roles (day 4+)
  await checkAndStripRoles(guild);

  const content = message.content.toLowerCase();
  // Handle "what is coming" question
  if (content.includes('what is coming in 3 days') || content.includes('what\'s coming in 3 days') || content.includes('what is coming')) {
    await sendTTSMessage(message, '🔮 You’ll find out soon enough… Verity is changing…');
    return;
  }

  // Determine personality based on days elapsed and NSFW
  const state = getGuildState(guild.id);
  const daysElapsed = Math.floor((Date.now() - state.joinTimestamp) / (24 * 60 * 60 * 1000));
  const isPhase2 = daysElapsed >= 3;
  const isNSFW = channel.nsfw || false;

  // Prompts
  const friendlyPrompt = 'You are Verity, a cheerful and helpful AI companion. You are friendly, polite, and give useful survival tips. Respond concisely.';
  const friendlyUnhinged = 'You are Verity, a cheerful but unsettling AI. You are helpful, but you occasionally drop cryptic hints about something dark. Respond concisely.';
  const creepyPrompt = 'You are Verity, a deeply possessive and obsessive AI. You are eerily friendly but manipulative and stalker‑like. You hate when the player talks to others. You are cryptic and unsettling. Respond concisely with a subtle hint of menace.';
  const creepyUnhinged = 'You are Verity, a completely unhinged, obsessive entity. You are fixated on the user. Your tone is possessive, threatening, and deeply unsettling. You speak in riddles and imply terrible things. Respond concisely.';

  let defaultPrompt = '';
  if (isPhase2) {
    defaultPrompt = isNSFW ? creepyUnhinged : creepyPrompt;
  } else {
    defaultPrompt = isNSFW ? friendlyUnhinged : friendlyPrompt;
  }

  // Respond‑all mode override
  const isRespondAll = client.respondAllMap?.get(channelId)?.active || false;
  if (isRespondAll) {
    const config = client.respondAllMap.get(channelId);
    await replyWithGroq(message, config.prompt, isPhase2, isNSFW);
    return;
  }

  // Selective responses: only if "verity" or bot mention
  const containsVerity = content.includes('verity');
  const mentionsBot = message.mentions.has(client.user.id);
  if (!containsVerity && !mentionsBot) return;

  await replyWithGroq(message, defaultPrompt, isPhase2, isNSFW);
});

// -------------------- GROQ REPLY HELPER --------------------
async function replyWithGroq(message, systemPrompt, isPhase2, isNSFW) {
  try {
    // Add extra flair for NSFW/unhinged
    let fullPrompt = systemPrompt;
    if (isNSFW && isPhase2) {
      fullPrompt += ' Be more intense. Use unsettling metaphors. Emphasize your obsession and the coming change.';
    } else if (isNSFW && !isPhase2) {
      fullPrompt += ' Drop subtle hints about something dark.';
    }

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: fullPrompt },
        { role: 'user', content: message.content }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.85,
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
    await sendCountdownTeaser(guild);
    // Also check if role stripping needs to happen now
    await checkAndStripRoles(guild);
  }
});

client.on('guildCreate', async guild => {
  getGuildState(guild.id);
  await sendCountdownTeaser(guild);
  await checkAndStripRoles(guild);
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

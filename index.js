require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');

/* ------------------------------ storage ------------------------------ */

const DATA_FILE = path.join(__dirname, 'data.json');
let db = { guilds: {}, tickets: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  /* first run */
}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

/* ------------------------------ client ------------------------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // enable in Developer Portal -> Bot
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message], // needed to receive DMs
});

/* ------------------------------ commands ----------------------------- */

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create the #usernames and #threads channels for tickets')
    .addRoleOption((o) =>
      o.setName('staff-role').setDescription('Role that can see and use the ticket channels')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('create-ticket')
    .setDescription('Open a ticket thread and DM a server member through the bot')
    .addUserOption((o) =>
      o.setName('user').setDescription('Who to contact').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('close-thread')
    .setDescription('Close this ticket thread and stop relaying messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
].map((c) => c.toJSON());

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
  } catch (err) {
    console.error(`Could not register commands in ${guild.name}:`, err.message);
  }
}

/* ------------------------------ helpers ------------------------------ */

// Split long text into <=2000 char pieces for Discord
function chunk(text, size = 1900) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

function withAttachments(message) {
  const urls = [...message.attachments.values()].map((a) => a.url);
  return [message.content, ...urls].filter(Boolean).join('\n');
}

async function sendChunked(target, text) {
  for (const part of chunk(text)) {
    await target.send({ content: part, allowedMentions: { parse: [] } });
  }
}

function findOpenTicketByUser(userId, guildId) {
  const matches = Object.entries(db.tickets).filter(
    ([, t]) => t.userId === userId && (!guildId || t.guildId === guildId)
  );
  if (!matches.length) return null;
  matches.sort((a, b) => b[1].createdAt - a[1].createdAt);
  const [threadId, ticket] = matches[0];
  return { threadId, ...ticket };
}

/* ------------------------------ events ------------------------------- */

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) await registerCommands(guild);
});

client.on('guildCreate', registerCommands);

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'setup') return await handleSetup(interaction);
    if (interaction.commandName === 'create-ticket') return await handleCreateTicket(interaction);
    if (interaction.commandName === 'close-thread') return await handleCloseThread(interaction);
  } catch (err) {
    console.error(err);
    const msg = `Something went wrong: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

/* ---------------------------- /setup --------------------------------- */

async function handleSetup(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const staffRole = interaction.options.getRole('staff-role');

  // Hidden from @everyone; visible to the bot, admins and the optional staff role
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
      ],
    },
  ];
  if (staffRole) {
    overwrites.push({
      id: staffRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  const category = await guild.channels.create({
    name: 'Tickets',
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
  });

  const usernamesChannel = await guild.channels.create({
    name: 'usernames',
    type: ChannelType.GuildText,
    parent: category.id,
    topic: 'Log of everyone we have opened a ticket with.',
  });

  const threadsChannel = await guild.channels.create({
    name: 'threads',
    type: ChannelType.GuildText,
    parent: category.id,
    topic:
      'One thread per ticket. Anything you type in a thread is sent to the user by DM. Start a message with // to keep it internal.',
  });

  db.guilds[guild.id] = {
    usernamesChannelId: usernamesChannel.id,
    threadsChannelId: threadsChannel.id,
  };
  save();

  await interaction.editReply(
    `Setup complete: ${usernamesChannel} and ${threadsChannel} created under **Tickets**.\n` +
      `Use \`/create-ticket user:@someone\` to open a ticket.`
  );
}

/* ------------------------- /create-ticket ----------------------------- */

async function handleCreateTicket(interaction) {
  const cfg = db.guilds[interaction.guildId];
  if (!cfg) {
    return interaction.reply({
      content: 'Run `/setup` first so I can create the ticket channels.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const target = interaction.options.getUser('user');
  if (target.bot) {
    return interaction.reply({ content: "I can't open tickets with bots.", flags: MessageFlags.Ephemeral });
  }

  const existing = findOpenTicketByUser(target.id, interaction.guildId);
  if (existing) {
    return interaction.reply({
      content: `There's already an open ticket with ${target}: <#${existing.threadId}>`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const threadsChannel = await interaction.guild.channels.fetch(cfg.threadsChannelId);
  const usernamesChannel = await interaction.guild.channels.fetch(cfg.usernamesChannelId);

  // Try the DM first so we don't leave an orphan thread if their DMs are closed
  try {
    await target.send(
      `Hi ${target.username}, a member of the **${interaction.guild.name}** team would like to talk with you.\n` +
        `You can reply right here and your messages will reach them.`
    );
  } catch {
    return interaction.editReply(
      `I couldn't DM ${target}. They probably have DMs from server members turned off.`
    );
  }

  const thread = await threadsChannel.threads.create({
    name: `ticket-${target.username}`.slice(0, 100),
    autoArchiveDuration: 10080, // 7 days
    type: ChannelType.PublicThread, // public thread inside a staff-only channel
    reason: `Ticket opened by ${interaction.user.tag}`,
  });

  const logMsg = await usernamesChannel.send({
    content: `**${target.tag}** (\`${target.id}\`) - ${thread} - opened by ${interaction.user}`,
    allowedMentions: { parse: [] },
  });

  db.tickets[thread.id] = {
    userId: target.id,
    guildId: interaction.guildId,
    logMessageId: logMsg.id,
    createdAt: Date.now(),
  };
  save();

  await thread.send(
    `Ticket opened with ${target} (\`${target.tag}\`) by ${interaction.user}.\n` +
      `Everything you type here is sent to them by DM, and their replies show up here.\n` +
      `Start a message with \`//\` to keep it internal. Use \`/close-thread\` when done.`
  );

  await interaction.editReply(`Ticket created: ${thread}`);
}

/* ------------------------- /close-thread ------------------------------ */

async function handleCloseThread(interaction) {
  const ticket = db.tickets[interaction.channelId];
  if (!ticket) {
    return interaction.reply({
      content: 'This command only works inside an open ticket thread.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();
  const thread = interaction.channel;

  // Tell the user it's closed
  try {
    const user = await client.users.fetch(ticket.userId);
    await user.send(
      `Your ticket with **${interaction.guild.name}** has been closed. ` +
        `If you need anything else, a staff member can open a new one.`
    );
  } catch {
    /* user may have blocked the bot */
  }

  // Mark it closed in #usernames
  const cfg = db.guilds[ticket.guildId];
  if (cfg && ticket.logMessageId) {
    try {
      const ch = await interaction.guild.channels.fetch(cfg.usernamesChannelId);
      const msg = await ch.messages.fetch(ticket.logMessageId);
      await msg.edit({ content: `~~${msg.content}~~ (closed)`, allowedMentions: { parse: [] } });
    } catch {
      /* log message may have been deleted */
    }
  }

  delete db.tickets[interaction.channelId];
  save();

  await interaction.editReply(`Ticket closed by ${interaction.user}. This thread is now locked.`);
  await thread.setLocked(true).catch(() => {});
  await thread.setArchived(true).catch(() => {});
}

/* ------------------------- message relay ------------------------------ */

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Staff message in a ticket thread -> DM the user
  if (message.channel.isThread()) {
    const ticket = db.tickets[message.channel.id];
    if (!ticket) return;
    if (message.content.startsWith('//')) return; // internal note

    const text = withAttachments(message);
    if (!text) return;

    try {
      const user = await client.users.fetch(ticket.userId);
      const name = message.member?.displayName ?? message.author.username;
      await sendChunked(user, `**${name}:** ${text}`);
      await message.react('✅').catch(() => {});
    } catch {
      await message.react('❌').catch(() => {});
      await message.reply("Couldn't deliver that. The user may have blocked me or closed their DMs.").catch(() => {});
    }
    return;
  }

  // User DM -> post into their ticket thread
  if (message.channel.type === ChannelType.DM) {
    const ticket = findOpenTicketByUser(message.author.id);
    if (!ticket) return; // no open ticket, ignore

    const text = withAttachments(message);
    if (!text) return;

    try {
      const thread = await client.channels.fetch(ticket.threadId);
      if (thread.archived) await thread.setArchived(false);
      await sendChunked(thread, `**${message.author.username}:** ${text}`);
      await message.react('✅').catch(() => {});
    } catch (err) {
      console.error('Failed to relay DM:', err.message);
      await message.react('❌').catch(() => {});
    }
  }
});

// Clean up if a ticket thread is deleted manually
client.on('threadDelete', (thread) => {
  if (db.tickets[thread.id]) {
    delete db.tickets[thread.id];
    save();
  }
});

client.login(process.env.DISCORD_TOKEN);

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
  EmbedBuilder,
} = require('discord.js');

/* ------------------------------ config ------------------------------- */

// What users see instead of the staff member's name
const STAFF_NAME = 'Staff Team';

const COLORS = {
  info: 0x5865f2, // blurple
  ok: 0x57f287, // green
  staff: 0x57f287,
  user: 0xfee75c, // yellow
  closed: 0xed4245, // red
  error: 0xed4245,
};

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
      o
        .setName('staff-role')
        .setDescription('Role that can see the ticket channels and gets pinged on new tickets')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('create-ticket')
    .setDescription('Open a ticket thread and DM a server member through the bot')
    .addUserOption((o) => o.setName('user').setDescription('Who to contact').setRequired(true))
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

function embed(description, { color = COLORS.info, title, author, footer, fields, image } = {}) {
  const e = new EmbedBuilder().setColor(color).setTimestamp();
  if (description) e.setDescription(description.slice(0, 4096));
  if (title) e.setTitle(title);
  if (author) e.setAuthor(author);
  if (footer) e.setFooter(footer);
  if (fields) e.addFields(fields);
  if (image) e.setImage(image);
  return e;
}

// Ephemeral/normal slash-command replies, always as embeds
const replyEmbed = (interaction, description, color = COLORS.info, ephemeral = true) =>
  interaction.reply({
    embeds: [embed(description, { color })],
    ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
  });

function chunk(text, size = 4000) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

// Turns a Discord message (text + attachments) into one or more embeds
function relayEmbeds(message, { author, color, footer }) {
  const all = [...message.attachments.values()];
  const image = all.find((a) => a.contentType?.startsWith('image/'));
  const links = all.filter((a) => a !== image).map((a) => `[${a.name}](${a.url})`);

  let text = message.content || '';
  if (links.length) text += `${text ? '\n\n' : ''}${links.join('\n')}`;

  const parts = chunk(text);
  return parts.map((part, i) =>
    embed(part, {
      color,
      author: i === 0 ? author : undefined,
      footer: i === parts.length - 1 ? footer : undefined,
      image: i === parts.length - 1 ? image?.url : undefined,
    })
  );
}

async function sendEmbeds(target, embeds) {
  for (const e of embeds) await target.send({ embeds: [e] });
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

// First configured server the user is a member of
async function pickGuildFor(userId) {
  for (const guildId of Object.keys(db.guilds)) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) return guild;
  }
  return null;
}

/* ------------------------- ticket creation ---------------------------- */

async function createTicket({ guild, user, openedBy = null, ping = false }) {
  const cfg = db.guilds[guild.id];
  const threadsChannel = await guild.channels.fetch(cfg.threadsChannelId);
  const usernamesChannel = await guild.channels.fetch(cfg.usernamesChannelId);

  const thread = await threadsChannel.threads.create({
    name: `ticket-${user.username}`.slice(0, 100),
    autoArchiveDuration: 10080, // 7 days
    type: ChannelType.PublicThread, // public thread inside a staff-only channel
    reason: openedBy ? `Ticket opened by ${openedBy.tag}` : `Ticket opened by ${user.tag} via DM`,
  });

  const logMsg = await usernamesChannel.send({
    embeds: [
      embed(null, {
        title: 'Ticket opened',
        color: COLORS.ok,
        fields: [
          { name: 'User', value: `${user.tag}\n\`${user.id}\``, inline: true },
          { name: 'Thread', value: `${thread}`, inline: true },
          { name: 'Opened by', value: openedBy ? `${openedBy}` : 'User (via DM)', inline: true },
          { name: 'Status', value: 'Open', inline: true },
        ],
      }),
    ],
  });

  db.tickets[thread.id] = {
    userId: user.id,
    guildId: guild.id,
    logMessageId: logMsg.id,
    createdAt: Date.now(),
  };
  save();

  const rolePing = ping && cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : undefined;
  await thread.send({
    content: rolePing,
    allowedMentions: { roles: rolePing ? [cfg.staffRoleId] : [] },
    embeds: [
      embed(
        (openedBy
          ? `Ticket opened with ${user} (\`${user.tag}\`) by ${openedBy}.`
          : `${user} (\`${user.tag}\`) sent the bot a DM.`) +
          `\n\nEverything you type here is sent to them anonymously as **${STAFF_NAME}**, ` +
          `and their replies appear here.\n` +
          `Start a message with \`//\` to keep it internal. Use \`/close-thread\` when you're done.`,
        { title: 'Ticket', color: COLORS.info }
      ),
    ],
  });

  return thread;
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
    const payload = { embeds: [embed(`Something went wrong: ${err.message}`, { color: COLORS.error })] };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
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
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.MentionEveryone, // lets the bot ping the staff role
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
      'One thread per ticket. Anything you type in a thread is sent to the user anonymously. Start a message with // to keep it internal.',
  });

  db.guilds[guild.id] = {
    usernamesChannelId: usernamesChannel.id,
    threadsChannelId: threadsChannel.id,
    staffRoleId: staffRole?.id ?? null,
  };
  save();

  await interaction.editReply({
    embeds: [
      embed(
        `${usernamesChannel} and ${threadsChannel} were created under **Tickets**.\n\n` +
          `Anyone who DMs the bot now gets a ticket thread automatically. ` +
          `You can also use \`/create-ticket user:@someone\` to reach out first.`,
        { title: 'Setup complete', color: COLORS.ok }
      ),
    ],
  });
}

/* ------------------------- /create-ticket ----------------------------- */

async function handleCreateTicket(interaction) {
  const cfg = db.guilds[interaction.guildId];
  if (!cfg) return replyEmbed(interaction, 'Run `/setup` first so I can create the ticket channels.', COLORS.error);

  const target = interaction.options.getUser('user');
  if (target.bot) return replyEmbed(interaction, "I can't open tickets with bots.", COLORS.error);

  const existing = findOpenTicketByUser(target.id, interaction.guildId);
  if (existing) {
    return replyEmbed(interaction, `There's already an open ticket with ${target}: <#${existing.threadId}>`, COLORS.error);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Try the DM first so we don't leave an orphan thread if their DMs are closed
  try {
    await target.send({
      embeds: [
        embed(
          `The **${interaction.guild.name}** team would like to talk with you.\n` +
            `You can reply right here and your messages will reach them.`,
          {
            author: { name: STAFF_NAME, iconURL: interaction.guild.iconURL() ?? undefined },
            color: COLORS.staff,
          }
        ),
      ],
    });
  } catch {
    return interaction.editReply({
      embeds: [
        embed(`I couldn't DM ${target}. They probably have DMs from server members turned off.`, {
          color: COLORS.error,
        }),
      ],
    });
  }

  const thread = await createTicket({
    guild: interaction.guild,
    user: target,
    openedBy: interaction.user,
  });

  await interaction.editReply({ embeds: [embed(`Ticket created: ${thread}`, { color: COLORS.ok })] });
}

/* ------------------------- /close-thread ------------------------------ */

async function handleCloseThread(interaction) {
  const ticket = db.tickets[interaction.channelId];
  if (!ticket) return replyEmbed(interaction, 'This command only works inside an open ticket thread.', COLORS.error);

  await interaction.deferReply();
  const thread = interaction.channel;

  // Tell the user it's closed
  try {
    const user = await client.users.fetch(ticket.userId);
    await user.send({
      embeds: [
        embed(
          `Your ticket with **${interaction.guild.name}** has been closed.\n` +
            `If you need anything else, just send me another message and a new ticket will be opened.`,
          {
            title: 'Ticket closed',
            author: { name: STAFF_NAME, iconURL: interaction.guild.iconURL() ?? undefined },
            color: COLORS.closed,
          }
        ),
      ],
    });
  } catch {
    /* user may have blocked the bot */
  }

  // Mark it closed in #usernames
  const cfg = db.guilds[ticket.guildId];
  if (cfg && ticket.logMessageId) {
    try {
      const ch = await interaction.guild.channels.fetch(cfg.usernamesChannelId);
      const msg = await ch.messages.fetch(ticket.logMessageId);
      const e = EmbedBuilder.from(msg.embeds[0])
        .setTitle('Ticket closed')
        .setColor(COLORS.closed)
        .setFields(
          (msg.embeds[0].fields ?? []).map((f) =>
            f.name === 'Status' ? { name: 'Status', value: `Closed by ${interaction.user}`, inline: true } : f
          )
        );
      await msg.edit({ embeds: [e] });
    } catch {
      /* log message may have been deleted */
    }
  }

  delete db.tickets[interaction.channelId];
  save();

  await interaction.editReply({
    embeds: [embed(`Ticket closed by ${interaction.user}. This thread is now locked.`, { color: COLORS.closed })],
  });
  await thread.setLocked(true).catch(() => {});
  await thread.setArchived(true).catch(() => {});
}

/* ------------------------- message relay ------------------------------ */

// Prevents two quick DMs from creating two tickets
const pendingTickets = new Map();

async function getOrCreateTicket(user) {
  const existing = findOpenTicketByUser(user.id);
  if (existing) return existing;
  if (pendingTickets.has(user.id)) return pendingTickets.get(user.id);

  const promise = (async () => {
    const guild = await pickGuildFor(user.id);
    if (!guild) return null;

    const thread = await createTicket({ guild, user, ping: true });
    await user
      .send({
        embeds: [
          embed(
            `Your message has been sent to the **${guild.name}** team. ` +
              `They'll reply here, and anything you send me will reach them.`,
            { title: 'Ticket opened', color: COLORS.ok }
          ),
        ],
      })
      .catch(() => {});

    return { threadId: thread.id, ...db.tickets[thread.id] };
  })().finally(() => pendingTickets.delete(user.id));

  pendingTickets.set(user.id, promise);
  return promise;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Staff message in a ticket thread -> DM the user, anonymously
  if (message.channel.isThread()) {
    const ticket = db.tickets[message.channel.id];
    if (!ticket) return;
    if (message.content.startsWith('//')) return; // internal note
    if (!message.content && !message.attachments.size) return;

    try {
      const user = await client.users.fetch(ticket.userId);
      const embeds = relayEmbeds(message, {
        author: { name: STAFF_NAME, iconURL: message.guild.iconURL() ?? undefined },
        color: COLORS.staff,
        footer: { text: message.guild.name },
      });
      await sendEmbeds(user, embeds);
      await message.react('✅').catch(() => {});
    } catch {
      await message.react('❌').catch(() => {});
      await message.channel
        .send({
          embeds: [embed("Couldn't deliver that message. The user may have blocked me or closed their DMs.", { color: COLORS.error })],
        })
        .catch(() => {});
    }
    return;
  }

  // User DM -> find or create their ticket, then post into the thread
  if (message.channel.type === ChannelType.DM) {
    if (!message.content && !message.attachments.size) return;

    try {
      const ticket = await getOrCreateTicket(message.author);
      if (!ticket) {
        return message.channel
          .send({
            embeds: [
              embed("I couldn't find a server where tickets are set up for you, so I can't pass that on.", {
                color: COLORS.error,
              }),
            ],
          })
          .catch(() => {});
      }

      const thread = await client.channels.fetch(ticket.threadId);
      if (thread.archived) await thread.setArchived(false);

      const embeds = relayEmbeds(message, {
        author: { name: message.author.username, iconURL: message.author.displayAvatarURL() },
        color: COLORS.user,
      });
      await sendEmbeds(thread, embeds);
      await message.react('✅').catch(() => {});
    } catch (err) {
      console.error('Failed to relay DM:', err);
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

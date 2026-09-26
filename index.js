require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  PermissionsBitField, ActivityType, ChannelType, StringSelectMenuBuilder
} = require('discord.js');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, '..', 'data', 'data.json');

function freshDB() {
  return {
    users: {}, coupons: {}, requests: {}, payments: {}, tickets: {},
    currencies: {}, logs: [],
    stock: Number(process.env.STOCK || 0),
    coinPrice: Number(process.env.COIN_PRICE || 100000),
    nextRequest: 1, nextTicket: 1,
    settings: {
      ownerId: process.env.OWNER_ID || '',
      staffRoleId: process.env.SUPPORT_ROLE_ID || '',
      ticketCategoryId: process.env.TICKET_CATEGORY_ID || '',
      logsChannelId: process.env.LOG_CHANNEL_ID || '',
      botName: '', status: '🛒 Store | /panel', statusType: 'WATCHING',
      welcomeMessage: 'أهلاً بك 👋 اختار الخدمة من الأزرار بالأسفل.'
    }
  };
}
function load() {
  try { return { ...freshDB(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; }
  catch { return freshDB(); }
}
let db = load();
for (const k of ['users','coupons','requests','payments','tickets','currencies','logs']) db[k] ??= {};
db.settings = { ...freshDB().settings, ...(db.settings || {}) };
db.nextRequest ??= 1; db.nextTicket ??= 1; db.coinPrice ??= Number(process.env.COIN_PRICE || 100000); db.stock ??= 0;
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
save();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});
const ownerOnly = id => id === (db.settings.ownerId || process.env.OWNER_ID);
const money = n => Number(n || 0).toLocaleString('en-US');
const userData = id => db.users[id] ??= { coins: 0, verified: false, username: '', linkedAt: null };
const currencies = () => Object.entries(db.currencies).filter(([, c]) => c.enabled !== false);
const staffRoleId = () => db.settings.staffRoleId || process.env.SUPPORT_ROLE_ID || '';
function isStaff(member) {
  return !!member && (ownerOnly(member.id) || (staffRoleId() && member.roles.cache.has(staffRoleId())) || member.permissions.has(PermissionsBitField.Flags.ManageChannels));
}
function log(type, data = {}) {
  db.logs.push({ type, at: new Date().toISOString(), ...data });
  if (db.logs.length > 500) db.logs.shift();
  save();
}
async function sendLog(guild, content) {
  const id = db.settings.logsChannelId || process.env.LOG_CHANNEL_ID;
  if (!guild || !id) return;
  const ch = guild.channels.cache.get(id);
  if (ch?.isTextBased()) await ch.send({ content }).catch(() => {});
}

function mainPanel() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket').setLabel('🎫 فتح تيكت').setStyle(ButtonStyle.Primary)
  )];
}
function storePanel() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('buy_coins').setLabel('💰 شراء كوين').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('buy_members').setLabel('🛒 شراء خدمة').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('stock').setLabel('📦 الاستوك').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('balance').setLabel('💳 رصيدي').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('payment_methods').setLabel('💰 طرق الدفع').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 إغلاق التيكت').setStyle(ButtonStyle.Danger)
    )
  ];
}
function currencyRows(prefix) {
  const arr = currencies();
  if (!arr.length) return [];
  const rows = [];
  for (let i = 0; i < arr.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const [id, c] of arr.slice(i, i + 5)) {
      row.addComponents(new ButtonBuilder().setCustomId(`${prefix}:${id}`).setLabel(`${c.emoji || '💳'} ${c.name}`.slice(0, 80)).setStyle(ButtonStyle.Primary));
    }
    rows.push(row);
  }
  return rows;
}
function paymentText(currencyId, amount, orderId) {
  const c = db.currencies[currencyId];
  if (!c) return '❌ العملة غير موجودة.';
  return String(c.instruction || 'انسخ الأمر التالي وأرسله:\n#pay {receiver} {amount}').replaceAll('{receiver}', c.receiver || '').replaceAll('{amount}', money(amount)).replaceAll('{orderId}', orderId);
}
function buyCoinsModal() {
  return new ModalBuilder().setCustomId('buy_coins_modal').setTitle('شراء كوين').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('عدد الكوين').setStyle(TextInputStyle.Short).setRequired(true))
  );
}
function buyServiceModal() {
  return new ModalBuilder().setCustomId('buy_service_modal').setTitle('شراء خدمة').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('service').setLabel('اسم الخدمة').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('الكمية').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('السعر بالكوين').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('coupon').setLabel('الكوبون (اختياري)').setStyle(TextInputStyle.Short).setRequired(false))
  );
}
function settingsValue(k) { return db.settings[k] ?? ''; }

const commands = [
  new SlashCommandBuilder().setName('panel').setDescription('إرسال لوحة فتح التيكت'),
  new SlashCommandBuilder().setName('dashboard').setDescription('لوحة إحصائيات البوت'),
  new SlashCommandBuilder().setName('balance').setDescription('عرض رصيدك'),
  new SlashCommandBuilder().setName('top').setDescription('أعلى الأرصدة'),
  new SlashCommandBuilder().setName('history').setDescription('سجل عمليات الرصيد'),
  new SlashCommandBuilder().setName('price').setDescription('عرض سعر الكوين'),
  new SlashCommandBuilder().setName('verify').setDescription('إثبات وربط حسابك'),
  new SlashCommandBuilder().setName('verify-status').setDescription('حالة التحقق'),
  new SlashCommandBuilder().setName('unlink').setDescription('فصل التحقق'),
  new SlashCommandBuilder().setName('botinfo').setDescription('معلومات البوت'),
  new SlashCommandBuilder().setName('refresh').setDescription('تحديث الإحصائيات'),
  new SlashCommandBuilder().setName('dm').setDescription('إرسال DM لعضو').addUserOption(o => o.setName('member').setDescription('العضو').setRequired(true)).addStringOption(o => o.setName('message').setDescription('الرسالة').setRequired(true)),
  new SlashCommandBuilder().setName('dms').setDescription('إرسال DM للأعضاء').addStringOption(o => o.setName('message').setDescription('الرسالة').setRequired(true)),
  new SlashCommandBuilder().setName('dmrole').setDescription('إرسال DM لأعضاء رتبة').addRoleOption(o => o.setName('role').setDescription('الرتبة').setRequired(true)).addStringOption(o => o.setName('message').setDescription('الرسالة').setRequired(true)),
  new SlashCommandBuilder().setName('currency-add').setDescription('إضافة عملة دفع').addStringOption(o => o.setName('id').setDescription('ID العملة').setRequired(true)).addStringOption(o => o.setName('name').setDescription('اسم العملة').setRequired(true)).addStringOption(o => o.setName('emoji').setDescription('الإيموجي').setRequired(true)).addStringOption(o => o.setName('receiver').setDescription('حساب الاستلام').setRequired(true)).addNumberOption(o => o.setName('rate').setDescription('كل 1 من العملة يساوي كم من السعر الأساسي').setRequired(true)),
  new SlashCommandBuilder().setName('currency-remove').setDescription('حذف عملة').addStringOption(o => o.setName('id').setDescription('ID العملة').setRequired(true)),
  new SlashCommandBuilder().setName('currency-list').setDescription('عرض العملات'),
  new SlashCommandBuilder().setName('currency-edit').setDescription('تعديل تعليمات الدفع').addStringOption(o => o.setName('id').setDescription('ID العملة').setRequired(true)).addStringOption(o => o.setName('instruction').setDescription('رسالة الدفع').setRequired(true)),
  new SlashCommandBuilder().setName('currency-message').setDescription('تعديل رسالة نجاح/رفض').addStringOption(o => o.setName('id').setDescription('ID العملة').setRequired(true)).addStringOption(o => o.setName('type').setDescription('success أو reject').setRequired(true)).addStringOption(o => o.setName('message').setDescription('الرسالة').setRequired(true)),
  new SlashCommandBuilder().setName('settings').setDescription('عرض الإعدادات'),
  new SlashCommandBuilder().setName('set-staff').setDescription('تحديد رتبة الستاف').addRoleOption(o => o.setName('role').setDescription('الرتبة').setRequired(true)),
  new SlashCommandBuilder().setName('set-ticket-category').setDescription('تحديد Category للتيكت').addChannelOption(o => o.setName('category').setDescription('Category').addChannelTypes(ChannelType.GuildCategory).setRequired(true)),
  new SlashCommandBuilder().setName('set-logs').setDescription('تحديد روم اللوج').addChannelOption(o => o.setName('channel').setDescription('الروم').addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName('bot-name').setDescription('تغيير اسم البوت').addStringOption(o => o.setName('name').setDescription('الاسم').setRequired(true)),
  new SlashCommandBuilder().setName('status').setDescription('تغيير حالة البوت').addStringOption(o => o.setName('text').setDescription('النص').setRequired(true)).addStringOption(o => o.setName('type').setDescription('PLAYING/WATCHING/LISTENING/COMPETING').setRequired(false)),
  new SlashCommandBuilder().setName('requests').setDescription('عرض الطلبات'),
  new SlashCommandBuilder().setName('coupons').setDescription('عرض الكوبونات'),
  new SlashCommandBuilder().setName('tickets').setDescription('عرض التيكتات المفتوحة'),
  new SlashCommandBuilder().setName('logs').setDescription('عرض آخر اللوجات')
].map(c => c.toJSON());

async function register() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
}
function applyStatus() {
  const types = { PLAYING: ActivityType.Playing, WATCHING: ActivityType.Watching, LISTENING: ActivityType.Listening, COMPETING: ActivityType.Competing };
  client.user.setActivity(settingsValue('status') || '🛒 Store | /panel', { type: types[String(settingsValue('statusType')).toUpperCase()] || ActivityType.Watching });
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { await register(); } catch (e) { console.error('Slash registration:', e.message); }
  applyStatus();
});

async function createTicket(interaction) {
  const g = interaction.guild;
  if (!g) return interaction.reply({ content: '❌ استخدم الزر داخل السيرفر.', ephemeral: true });
  const existing = Object.values(db.tickets).find(t => t.guildId === g.id && t.userId === interaction.user.id && t.open);
  if (existing) {
    const ch = g.channels.cache.get(existing.channelId);
    return interaction.reply({ content: `❌ عندك تيكت مفتوح بالفعل: ${ch ? `<#${ch.id}>` : 'القناة غير متاحة.'}`, ephemeral: true });
  }
  const me = g.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageChannels)) return interaction.reply({ content: '❌ البوت يحتاج Manage Channels.', ephemeral: true });
  const overwrites = [
    { id: g.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.EmbedLinks] }
  ];
  const role = staffRoleId();
  if (role) overwrites.push({ id: role, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] });
  const n = String(db.nextTicket++).padStart(4, '0');
  const safeUser = interaction.user.username.toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 40) || interaction.user.id;
  const safeName = `ticket-${n}-${safeUser}`.slice(0, 90);
  let ch;
  try {
    ch = await g.channels.create({ name: safeName, type: ChannelType.GuildText, parent: settingsValue('ticketCategoryId') || process.env.TICKET_CATEGORY_ID || undefined, permissionOverwrites: overwrites, topic: `Store Ticket #${n} • ${interaction.user.tag}` });
  } catch (e) {
    console.error(e);
    return interaction.reply({ content: '❌ فشل إنشاء التيكت. تأكد من Manage Channels وأن الـCategory صحيحة.', ephemeral: true });
  }
  db.tickets[ch.id] = { channelId: ch.id, guildId: g.id, userId: interaction.user.id, number: n, open: true, createdAt: new Date().toISOString(), claimedBy: null };
  save();
  const embed = new EmbedBuilder().setTitle(`🎫 تيكت المتجر #${n}`).setDescription(`${settingsValue('welcomeMessage')}\n\n👤 صاحب التيكت: <@${interaction.user.id}>\n\n**الخدمات موجودة هنا داخل التيكت فقط.**`).setColor(0x5865F2);
  await ch.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: storePanel() });
  log('ticket_open', { guildId: g.id, channelId: ch.id, userId: interaction.user.id, number: n });
  await sendLog(g, `🎫 فتح تيكت #${n}\n👤 <@${interaction.user.id}>\n📁 <#${ch.id}>`);
  return interaction.reply({ content: `✅ تم إنشاء تيكتك: <#${ch.id}>`, ephemeral: true });
}

function serviceOrderEmbed(order) {
  return new EmbedBuilder().setTitle(`🛒 طلب #${order.id}`).setDescription(`👤 <@${order.userId}>\n📦 الخدمة: **${order.service}**\n🔢 الكمية: **${order.quantity}**\n💰 السعر: **${money(order.baseCost)} كوين**\n📌 الحالة: **${order.status}**`).setColor(0x2b2d31);
}
async function paymentChoice(interaction, order) {
  const rows = currencyRows(`pay:${order.id}`);
  if (!rows.length) return interaction.reply({ content: '❌ لا توجد عملات دفع مضافة حاليًا.', ephemeral: true });
  return interaction.reply({ content: `💳 **اختر طريقة الدفع للطلب #${order.id}**\nالسعر الأساسي: **${money(order.baseCost)}** كوين`, components: rows, ephemeral: true });
}

client.on('guildMemberAdd', async member => {
  if (member.guild.id !== process.env.GUILD_ID) return;
  await member.send('أهلاً بك 👋\nتم تسجيل دخولك للسيرفر بنجاح ✅\nلو محتاج تثبت حسابك استخدم أمر **/verify** في السيرفر.').catch(() => {});
});

app.get('/oauth', (req, res) => {
  if (!req.query.user) return res.status(400).send('Missing user.');
  const p = new URLSearchParams({ client_id: process.env.CLIENT_ID, response_type: 'code', redirect_uri: process.env.OAUTH_REDIRECT_URI, scope: 'identify guilds.join', state: String(req.query.user) });
  res.redirect('https://discord.com/oauth2/authorize?' + p);
});
app.get('/callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).send('Missing OAuth code.');
    const body = new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.OAUTH_CLIENT_SECRET, grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: process.env.OAUTH_REDIRECT_URI });
    const tr = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const t = await tr.json();
    if (!t.access_token) return res.status(400).send('OAuth failed.');
    const mr = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${t.access_token}` } });
    const me = await mr.json();
    const u = userData(me.id); u.verified = true; u.username = me.username; u.linkedAt = new Date().toISOString(); u.scopes = ['identify', 'guilds.join']; save();
    log('verify', { userId: me.id });
    res.send('تم إثبات وربط حسابك بنجاح ✅ يمكنك الرجوع إلى Discord الآن.');
  } catch (e) { console.error(e); res.status(500).send('OAuth error.'); }
});
app.listen(PORT, () => console.log(`Web server on ${PORT}`));

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const n = interaction.commandName;
      if (['panel','balance','price','verify','verify-status','unlink','botinfo','refresh','top','history'].includes(n) === false && !ownerOnly(interaction.user.id) && !['dm','dms','dmrole'].includes(n)) {
        return interaction.reply({ content: '❌ هذا الأمر للإدارة.', ephemeral: true });
      }
      if (n === 'panel') return interaction.reply({ content: '🎫 **افتح تيكت لبدء الشراء**', components: mainPanel() });
      if (n === 'balance') return interaction.reply({ content: `💰 رصيدك: **${money(userData(interaction.user.id).coins)} كوين**`, ephemeral: true });
      if (n === 'price') return interaction.reply({ content: `💰 سعر الكوين: **${money(db.coinPrice)}**`, ephemeral: true });
      if (n === 'verify') { const url = `${process.env.OAUTH_PUBLIC_URL || ''}/oauth?user=${interaction.user.id}`; return interaction.reply({ content: 'اضغط الزر لإثبات وربط حسابك:', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('🔐 Verify').setStyle(ButtonStyle.Link).setURL(url))], ephemeral: true }); }
      if (n === 'verify-status') { const u = userData(interaction.user.id); return interaction.reply({ content: u.verified ? `✅ حسابك مرتبط منذ ${u.linkedAt || 'وقت غير معروف'}.` : '❌ حسابك غير مرتبط.', ephemeral: true }); }
      if (n === 'unlink') { if (!ownerOnly(interaction.user.id)) return interaction.reply({ content: '❌ للمالك فقط.', ephemeral: true }); const u = userData(interaction.user.id); u.verified = false; u.linkedAt = null; save(); return interaction.reply({ content: '✅ تم فصل حالة الحساب محليًا.', ephemeral: true }); }
      if (n === 'botinfo') return interaction.reply({ content: `🤖 ${client.user.tag}\n👥 Servers: ${client.guilds.cache.size}\n🎫 Open tickets: ${Object.values(db.tickets).filter(t => t.open).length}\n🛒 Orders: ${Object.keys(db.requests).length}`, ephemeral: true });
      if (n === 'refresh' || n === 'dashboard') { const verified = Object.values(db.users).filter(u => u.verified).length; return interaction.reply({ content: `📊 Dashboard\n👥 Members: ${interaction.guild?.memberCount || 0}\n✅ Verified: ${verified}\n🎫 Open Tickets: ${Object.values(db.tickets).filter(t => t.open).length}\n🛒 Orders: ${Object.keys(db.requests).length}\n⏳ Pending: ${Object.values(db.requests).filter(o => String(o.status).includes('pending')).length}\n📦 Stock: ${db.stock}\n💳 Currencies: ${currencies().length}`, ephemeral: true }); }
      if (n === 'top') { const list = Object.entries(db.users).sort((a,b)=>Number(b[1].coins)-Number(a[1].coins)).slice(0,10).map(([id,u],i)=>`${i+1}. <@${id}> — ${money(u.coins)}`).join('\n') || 'لا يوجد بيانات.'; return interaction.reply({ content: `🏆 Top\n${list}`, ephemeral: true }); }
      if (n === 'history') return interaction.reply({ content: '📜 سجل الرصيد مفصل في Logs حسب العمليات المسجلة.', ephemeral: true });
      if (n === 'dm' || n === 'dms' || n === 'dmrole') {
        if (!ownerOnly(interaction.user.id)) return interaction.reply({ content: '❌ للمالك فقط.', ephemeral: true });
        if (n === 'dm') { const u=interaction.options.getUser('member'), msg=interaction.options.getString('message'); await u.send(`<@${u.id}> ${msg}`); log('dm',{to:u.id}); return interaction.reply({content:`✅ تم إرسال DM إلى <@${u.id}>.`,ephemeral:true}); }
        await interaction.deferReply({ephemeral:true}); let members = await interaction.guild.members.fetch(); if(n==='dmrole'){const r=interaction.options.getRole('role');members=members.filter(m=>m.roles.cache.has(r.id));} let sent=0,failed=0; for(const [,m] of members){if(m.user.bot)continue;try{await m.send(`<@${m.id}> ${interaction.options.getString('message')}`);sent++;await new Promise(r=>setTimeout(r,1100));}catch{failed++;}} log('dm_bulk',{sent,failed}); return interaction.editReply(`📨 انتهى الإرسال.\n✅ ${sent}\n❌ ${failed}`);
      }
      if (n === 'currency-add') { const id=interaction.options.getString('id').toLowerCase(), rate=interaction.options.getNumber('rate'); if(!/^[a-z0-9_-]{2,30}$/.test(id)||rate<=0)return interaction.reply({content:'❌ ID أو Rate غير صحيح.',ephemeral:true}); db.currencies[id]={name:interaction.options.getString('name'),emoji:interaction.options.getString('emoji'),receiver:interaction.options.getString('receiver'),rate,enabled:true,instruction:'انسخ الأمر التالي وأرسله:\n#pay {receiver} {amount}\n\nبعد التحويل اضغط **تم الدفع**.',successMessage:'✅ تم تأكيد الدفع لطلبك **#{orderId}**.',rejectMessage:'❌ تم رفض الدفع لطلبك **#{orderId}**.'};save();return interaction.reply({content:'✅ تمت إضافة العملة.',ephemeral:true}); }
      if (n === 'currency-remove') { const id=interaction.options.getString('id').toLowerCase(); delete db.currencies[id]; save(); return interaction.reply({content:'✅ تم حذف العملة.',ephemeral:true}); }
      if (n === 'currency-list') { const x=Object.entries(db.currencies).map(([id,c])=>`${c.emoji||'💳'} **${c.name}** — ${id} — Rate ${c.rate} — ${c.enabled===false?'🔴':'🟢'}`).join('\n')||'لا توجد عملات.'; return interaction.reply({content:x,ephemeral:true}); }
      if (n === 'currency-edit') { const id=interaction.options.getString('id').toLowerCase(),c=db.currencies[id];if(!c)return interaction.reply({content:'❌ غير موجودة.',ephemeral:true});c.instruction=interaction.options.getString('instruction');save();return interaction.reply({content:'✅ تم حفظ التعليمات. استخدم {receiver} {amount} {orderId}.',ephemeral:true}); }
      if (n === 'currency-message') { const id=interaction.options.getString('id').toLowerCase(),c=db.currencies[id],type=interaction.options.getString('type');if(!c||!['success','reject'].includes(type))return interaction.reply({content:'❌ بيانات غير صحيحة.',ephemeral:true});c[type==='success'?'successMessage':'rejectMessage']=interaction.options.getString('message');save();return interaction.reply({content:'✅ تم حفظ الرسالة.',ephemeral:true}); }
      if (n === 'settings') return interaction.reply({content:`⚙️ Staff: ${db.settings.staffRoleId||'غير محدد'}\n📁 Category: ${db.settings.ticketCategoryId||'غير محدد'}\n📝 Logs: ${db.settings.logsChannelId||'غير محدد'}\n🤖 Name: ${db.settings.botName||client.user.username}\n💰 Coin price: ${money(db.coinPrice)}`,ephemeral:true});
      if (n === 'set-staff') { db.settings.staffRoleId=interaction.options.getRole('role').id;save();return interaction.reply({content:'✅ تم تحديد رتبة الإدارة التي ترى التيكتات.',ephemeral:true}); }
      if (n === 'set-ticket-category') { db.settings.ticketCategoryId=interaction.options.getChannel('category').id;save();return interaction.reply({content:'✅ تم تحديد Category.',ephemeral:true}); }
      if (n === 'set-logs') { db.settings.logsChannelId=interaction.options.getChannel('channel').id;save();return interaction.reply({content:'✅ تم تحديد روم اللوج.',ephemeral:true}); }
      if (n === 'bot-name') { const name=interaction.options.getString('name');db.settings.botName=name;save();await client.user.setUsername(name).catch(()=>{});return interaction.reply({content:'✅ تم تغيير اسم البوت.',ephemeral:true}); }
      if (n === 'status') { db.settings.status=interaction.options.getString('text');db.settings.statusType=(interaction.options.getString('type')||'WATCHING').toUpperCase();save();applyStatus();return interaction.reply({content:'✅ تم تغيير الحالة.',ephemeral:true}); }
      if (n === 'requests') { const x=Object.values(db.requests).slice(-15).reverse().map(o=>`#${o.id} • <@${o.userId}> • ${o.service||o.type} • ${o.status}`).join('\n')||'لا يوجد طلبات.';return interaction.reply({content:x,ephemeral:true}); }
      if (n === 'coupons') { const x=Object.entries(db.coupons).map(([k,c])=>`${k} — ${c.discount}% — uses ${c.usesLeft===null?'∞':c.usesLeft}`).join('\n')||'لا يوجد كوبونات.';return interaction.reply({content:x,ephemeral:true}); }
      if (n === 'tickets') { const x=Object.values(db.tickets).filter(t=>t.open).map(t=>`#${t.number} • <#${t.channelId}> • <@${t.userId}>`).join('\n')||'لا يوجد تيكتات مفتوحة.';return interaction.reply({content:x,ephemeral:true}); }
      if (n === 'logs') { const x=db.logs.slice(-15).reverse().map(l=>`${l.at} • ${l.type}`).join('\n')||'لا يوجد Logs.';return interaction.reply({content:x,ephemeral:true}); }
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'open_ticket') return createTicket(interaction);
      const ticket = db.tickets[interaction.channelId];
      if (id === 'close_ticket') {
        if (!ticket) return interaction.reply({content:'❌ هذا ليس تيكت مسجل.',ephemeral:true});
        if (ticket.userId !== interaction.user.id && !isStaff(interaction.member)) return interaction.reply({content:'❌ لا تملك صلاحية إغلاقه.',ephemeral:true});
        ticket.open=false;ticket.closedAt=new Date().toISOString();save();log('ticket_close',{channelId:interaction.channelId,userId:interaction.user.id,number:ticket.number});await sendLog(interaction.guild,`🔒 إغلاق تيكت #${ticket.number} بواسطة <@${interaction.user.id}>`);await interaction.reply('🔒 سيتم إغلاق التيكت خلال 3 ثواني.');setTimeout(()=>interaction.channel.delete().catch(()=>{}),3000);return;
      }
      if (id === 'stock') return interaction.reply({content:`📦 الاستوك الحالي: **${money(db.stock)}**`,ephemeral:true});
      if (id === 'balance') return interaction.reply({content:`💰 رصيدك: **${money(userData(interaction.user.id).coins)} كوين**`,ephemeral:true});
      if (id === 'payment_methods') { const x=currencies().map(([k,c])=>`${c.emoji||'💳'} **${c.name}** — الدفع إلى ${c.receiver}`).join('\n')||'❌ لا توجد عملات مضافة.';return interaction.reply({content:`💳 طرق الدفع المتاحة:\n${x}`,ephemeral:true}); }
      if (id === 'buy_coins' || id === 'buy_members') return interaction.showModal(id==='buy_coins'?buyCoinsModal():buyServiceModal());
      if (id.startsWith('pay:')) {
        const [,orderId,currencyId]=id.split(':');const o=db.requests[orderId],c=db.currencies[currencyId];if(!o||!c||c.enabled===false)return interaction.reply({content:'❌ الطلب أو العملة غير متاحة.',ephemeral:true});if(o.userId!==interaction.user.id)return interaction.reply({content:'❌ هذا الطلب ليس لك.',ephemeral:true});const amount=Math.ceil(o.baseCost/Number(c.rate));o.currencyId=currencyId;o.currencyAmount=amount;o.status='awaiting_payment';db.payments[orderId]={orderId,userId:interaction.user.id,currencyId,amount,status:'awaiting_user_confirmation',createdAt:new Date().toISOString()};save();return interaction.reply({content:`🧾 **طلب #${orderId}**\n\n${paymentText(currencyId,amount,orderId)}\n\n💰 المبلغ: **${money(amount)} ${c.name}**`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`paid:${orderId}`).setLabel('✅ تم الدفع').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`cancelpay:${orderId}`).setLabel('❌ إلغاء').setStyle(ButtonStyle.Danger))],ephemeral:true});
      }
      if (id.startsWith('paid:')) { const orderId=id.split(':')[1],p=db.payments[orderId],o=db.requests[orderId];if(!p||!o||p.userId!==interaction.user.id)return interaction.reply({content:'❌ الدفع غير موجود.',ephemeral:true});p.status='pending_owner';o.status='pending_payment_review';save();const owner=await client.users.fetch(db.settings.ownerId||process.env.OWNER_ID).catch(()=>null);if(owner)await owner.send({content:`💳 **إثبات دفع جديد #${orderId}**\n👤 <@${o.userId}>\n💰 ${money(p.amount)} ${db.currencies[p.currencyId].name}\n📦 ${o.service||o.type} × ${o.quantity}`,components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`payapprove:${orderId}`).setLabel('✅ تأكيد الدفع').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`payreject:${orderId}`).setLabel('❌ رفض الدفع').setStyle(ButtonStyle.Danger))]});return interaction.update({content:'📨 تم إرسال الطلب للإدارة للمراجعة. الدفع غير مؤكد حتى يتم اعتماده.',components:[]}); }
      if (id.startsWith('cancelpay:')) { const orderId=id.split(':')[1];if(db.payments[orderId])db.payments[orderId].status='cancelled';if(db.requests[orderId])db.requests[orderId].status='cancelled';save();return interaction.update({content:'❌ تم إلغاء الدفع.',components:[]}); }
      if (id.startsWith('payapprove:') || id.startsWith('payreject:')) { if(!ownerOnly(interaction.user.id))return interaction.reply({content:'❌ للمالك فقط.',ephemeral:true});const orderId=id.split(':')[1],p=db.payments[orderId],o=db.requests[orderId],c=p&&db.currencies[p.currencyId];if(!p||!o||!c)return interaction.reply({content:'❌ الطلب غير موجود.',ephemeral:true});const approved=id.startsWith('payapprove:');p.status=approved?'approved':'rejected';o.status=approved?'payment_approved':'payment_rejected';save();const msg=(approved?c.successMessage:c.rejectMessage).replaceAll('{orderId}',orderId);await client.users.send(o.userId,msg).catch(()=>{});log(approved?'payment_approved':'payment_rejected',{orderId,userId:o.userId});return interaction.update({content:approved?`✅ تم تأكيد الدفع #${orderId}.`:`❌ تم رفض الدفع #${orderId}.`,components:[]}); }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'buy_coins_modal') { const amount=Number(interaction.fields.getTextInputValue('amount'));if(!Number.isInteger(amount)||amount<=0)return interaction.reply({content:'❌ العدد غير صحيح.',ephemeral:true});const id=String(db.nextRequest++),baseCost=amount*db.coinPrice;db.requests[id]={id,userId:interaction.user.id,type:'coins',service:'شراء كوين',quantity:amount,baseCost,status:'choosing_payment',createdAt:new Date().toISOString()};save();return paymentChoice(interaction,db.requests[id]); }
      if (interaction.customId === 'buy_service_modal') { const service=interaction.fields.getTextInputValue('service'),quantity=Number(interaction.fields.getTextInputValue('quantity')),price=Number(interaction.fields.getTextInputValue('price')),coupon=(interaction.fields.getTextInputValue('coupon')||'').trim().toUpperCase();if(!service||!Number.isInteger(quantity)||quantity<=0||!Number.isFinite(price)||price<=0)return interaction.reply({content:'❌ البيانات غير صحيحة.',ephemeral:true});let discount=0;if(coupon){const c=db.coupons[coupon];if(!c||(c.usesLeft!==null&&c.usesLeft<=0))return interaction.reply({content:'❌ الكوبون غير صالح.',ephemeral:true});discount=Math.min(100,Math.max(0,Number(c.discount||0)));if(c.usesLeft!==null)c.usesLeft--;}
        const baseCost=Math.floor(price*(100-discount)/100),id=String(db.nextRequest++);db.requests[id]={id,userId:interaction.user.id,type:'service',service,quantity,coupon,discount,baseCost,status:'choosing_payment',createdAt:new Date().toISOString()};save();return paymentChoice(interaction,db.requests[id]); }
    }
  } catch (e) { console.error('interaction error', e); if (!interaction.replied && !interaction.deferred) await interaction.reply({content:'❌ حدث خطأ غير متوقع.',ephemeral:true}).catch(()=>{}); }
});

client.on('messageCreate', async m => {
  if (m.author.bot || !ownerOnly(m.author.id) || !m.content.startsWith('+')) return;
  const [cmd, ...a] = m.content.trim().split(/\s+/);
  if (cmd === '+give') { const u=m.mentions.users.first(),x=Number(a[1]);if(!u||x<=0)return m.reply('استخدام: +give @user amount');userData(u.id).coins+=x;save();log('coins_add',{userId:u.id,amount:x,by:m.author.id});return m.reply(`✅ أضيف ${money(x)} كوين.`); }
  if (cmd === '-remove') { const u=m.mentions.users.first(),x=Number(a[1]);if(!u||x<=0)return m.reply('استخدام: -remove @user amount');userData(u.id).coins=Math.max(0,userData(u.id).coins-x);save();log('coins_remove',{userId:u.id,amount:x,by:m.author.id});return m.reply('✅ تم الخصم.'); }
  if (cmd === '+price') { const x=Number(a[0]);if(x<=0)return m.reply('استخدام: +price amount');db.coinPrice=x;save();return m.reply(`✅ سعر الكوين: ${money(x)}`); }
  if (cmd === '+add') { const x=Number(a[0]);if(x<=0)return m.reply('استخدام: +add quantity');db.stock+=x;save();return m.reply(`✅ تم إضافة ${x} للاستوك.`); }
  if (cmd === '+coupon') { const code=(a[0]||'').toUpperCase(),d=Number(a[1]),uses=a[2]===undefined?null:Number(a[2]);if(!code||d<0||d>100)return m.reply('استخدام: +coupon CODE DISCOUNT [USES]');db.coupons[code]={discount:d,usesLeft:Number.isFinite(uses)?uses:null};save();return m.reply(`✅ تم إنشاء ${code}`); }
  if (cmd === '+delcoupon') { delete db.coupons[(a[0]||'').toUpperCase()];save();return m.reply('✅ تم حذف الكوبون.'); }
});

client.login(process.env.DISCORD_TOKEN);

require("dotenv").config();

const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ChannelType
} = require("discord.js");
const express = require("express");
const fs = require("fs");
const path = require("path");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});

const fresh = () => ({
  settings: {
    coinPrice: Number(process.env.COIN_PRICE || 100000),
    creditRecipientId: process.env.CREDIT_RECIPIENT_ID || "",
    ticketCategoryId: process.env.TICKET_CATEGORY_ID || ""
  },
  users:{}, coupons:{}, tickets:{}, requests:{}
});

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    const x=fresh(); fs.writeFileSync(DATA_FILE,JSON.stringify(x,null,2)); return x;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }
  catch { return fresh(); }
}
let db=load();
const save=()=>fs.writeFileSync(DATA_FILE,JSON.stringify(db,null,2));
const ownerOnly=i=>i.user.id===process.env.OWNER_ID;
const fmt=n=>Number(n).toLocaleString("en-US");

function getUser(id) {
  if(!db.users[id]) db.users[id]={coins:0,totalBought:0,oauth:null};
  return db.users[id];
}

function storeEmbed() {
  return new EmbedBuilder()
    .setTitle("🛒 متجر الكوينز")
    .setDescription(
      `💰 سعر الكوين: **${fmt(db.settings.coinPrice)} كريدت**\n\n`+
      `🔐 إثبات نفسك: اربط حسابك بموافقتك.\n`+
      `🎟️ افتح تذكرة للشراء.\n`+
      `📋 الطلبات الجديدة تحتاج موافقة الـOwner.\n\n`+
      `⚠️ هذا الإصدار لا ينفذ إضافة جماعية للأعضاء.`
    );
}

function storeButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("verify").setLabel("إثبات نفسك").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("open_ticket").setLabel("فتح تذكرة").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("balance").setLabel("رصيدي").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("new_request").setLabel("إنشاء طلب").setStyle(ButtonStyle.Primary)
  );
}

const commands=[
  new SlashCommandBuilder().setName("panel").setDescription("إرسال لوحة المتجر"),
  new SlashCommandBuilder().setName("balance").setDescription("عرض رصيدك"),
  new SlashCommandBuilder().setName("price").setDescription("تغيير سعر الكوين")
    .addIntegerOption(o=>o.setName("amount").setDescription("السعر").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("addcoins").setDescription("إضافة Coins")
    .addUserOption(o=>o.setName("user").setDescription("المستخدم").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("الكمية").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("removecoins").setDescription("خصم Coins")
    .addUserOption(o=>o.setName("user").setDescription("المستخدم").setRequired(true))
    .addIntegerOption(o=>o.setName("amount").setDescription("الكمية").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("coupon").setDescription("إدارة كوبونات")
    .addSubcommand(s=>s.setName("create").setDescription("إنشاء كوبون")
      .addStringOption(o=>o.setName("code").setDescription("الكود").setRequired(true))
      .addIntegerOption(o=>o.setName("coins").setDescription("الكوينز").setRequired(true).setMinValue(1)))
    .addSubcommand(s=>s.setName("delete").setDescription("حذف كوبون")
      .addStringOption(o=>o.setName("code").setDescription("الكود").setRequired(true))),
  new SlashCommandBuilder().setName("couponuse").setDescription("استخدام كوبون")
    .addStringOption(o=>o.setName("code").setDescription("الكود").setRequired(true)),
  new SlashCommandBuilder().setName("request").setDescription("إنشاء طلب يحتاج موافقة الـOwner")
    .addIntegerOption(o=>o.setName("coins").setDescription("عدد الكوينز").setRequired(true).setMinValue(1))
    .addStringOption(o=>o.setName("guild_id").setDescription("ID السيرفر").setRequired(true)),
  new SlashCommandBuilder().setName("requests").setDescription("عرض الطلبات المعلقة"),
  new SlashCommandBuilder().setName("refresh").setDescription("إحصائيات النظام")
].map(x=>x.toJSON());

async function registerCommands(){
  const rest=new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  const route=process.env.GUILD_ID
    ? Routes.applicationGuildCommands(process.env.CLIENT_ID,process.env.GUILD_ID)
    : Routes.applicationCommands(process.env.CLIENT_ID);
  await rest.put(route,{body:commands});
}

const app=express();

app.get("/",(_,res)=>res.send("OAuth server is running."));

app.get("/oauth",(req,res)=>{
  if(!req.query.user) return res.status(400).send("Missing user.");
  const params=new URLSearchParams({
    client_id:process.env.CLIENT_ID,
    response_type:"code",
    redirect_uri:process.env.OAUTH_REDIRECT_URI,
    scope:"identify guilds.join",
    state:String(req.query.user)
  });
  res.redirect("https://discord.com/oauth2/authorize?"+params.toString());
});

app.get("/callback",async(req,res)=>{
  try{
    if(!req.query.code||!req.query.state) return res.status(400).send("Invalid callback.");

    const tokenRes=await fetch("https://discord.com/api/v10/oauth2/token",{
      method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        client_id:process.env.CLIENT_ID,
        client_secret:process.env.OAUTH_CLIENT_SECRET,
        grant_type:"authorization_code",
        code:String(req.query.code),
        redirect_uri:process.env.OAUTH_REDIRECT_URI
      })
    });
    if(!tokenRes.ok) return res.status(400).send("OAuth token exchange failed.");

    const token=await tokenRes.json();
    const meRes=await fetch("https://discord.com/api/v10/users/@me",{
      headers:{Authorization:`Bearer ${token.access_token}`}
    });
    if(!meRes.ok) return res.status(400).send("Could not read Discord user.");

    const discordUser=await meRes.json();
    const local=getUser(String(req.query.state));

    // We keep identity/consent metadata, not the OAuth access token.
    local.oauth={
      discordId:discordUser.id,
      username:discordUser.username,
      linkedAt:new Date().toISOString(),
      scopes:token.scope,
      consented:true
    };
    save();

    res.send(`
      <!doctype html><html lang="ar" dir="rtl">
      <meta charset="utf-8">
      <body style="font-family:Arial;padding:40px">
      <h2>تم إثبات وربط حسابك بنجاح ✅</h2>
      <p>يمكنك الرجوع إلى Discord الآن.</p>
      </body></html>
    `);
  }catch(e){console.error(e);res.status(500).send("OAuth error.");}
});

app.listen(Number(process.env.PORT||3000),()=>console.log("OAuth server ready."));

client.once("ready",async()=>{
  console.log(`Logged in as ${client.user.tag}`);
  try{await registerCommands();console.log("Commands registered.");}
  catch(e){console.error(e);}
});

async function sendOwnerRequest(requestId){
  const owner=await client.users.fetch(process.env.OWNER_ID).catch(()=>null);
  if(!owner)return;

  const r=db.requests[requestId];
  const row=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`approve:${requestId}`).setLabel("موافقة").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`reject:${requestId}`).setLabel("رفض").setStyle(ButtonStyle.Danger)
  );

  await owner.send({
    embeds:[new EmbedBuilder().setTitle("📋 طلب جديد يحتاج موافقة")
      .setDescription(
        `👤 المستخدم: <@${r.userId}>\n`+
        `🪙 Coins: **${r.coins}**\n`+
        `🆔 Guild ID: \`${r.guildId}\`\n`+
        `📌 الحالة: **pending_owner**`
      )],
    components:[row]
  }).catch(()=>{});
}

client.on("interactionCreate",async i=>{
  try{
    if(i.isChatInputCommand()){
      const n=i.commandName;

      if(n==="panel"){
        if(!ownerOnly(i)&&!i.memberPermissions?.has(PermissionFlagsBits.Administrator))
          return i.reply({content:"❌ ليس لديك صلاحية.",ephemeral:true});
        return i.reply({embeds:[storeEmbed()],components:[storeButtons()]});
      }

      if(n==="balance")
        return i.reply({content:`💰 رصيدك: **${getUser(i.user.id).coins} Coin**`,ephemeral:true});

      if(n==="price"){
        if(!ownerOnly(i))return i.reply({content:"❌ Owner فقط.",ephemeral:true});
        db.settings.coinPrice=i.options.getInteger("amount");save();
        return i.reply(`✅ سعر الكوين أصبح **${fmt(db.settings.coinPrice)} كريدت**.`);
      }

      if(n==="addcoins"||n==="removecoins"){
        if(!ownerOnly(i))return i.reply({content:"❌ Owner فقط.",ephemeral:true});
        const target=i.options.getUser("user"),amount=i.options.getInteger("amount"),u=getUser(target.id);
        if(n==="addcoins"){u.coins+=amount;u.totalBought+=amount;}
        else{
          if(u.coins<amount)return i.reply({content:"❌ الرصيد غير كافٍ.",ephemeral:true});
          u.coins-=amount;
        }
        save();
        return i.reply(`✅ رصيد ${target} أصبح **${u.coins} Coin**.`);
      }

      if(n==="coupon"){
        if(!ownerOnly(i))return i.reply({content:"❌ Owner فقط.",ephemeral:true});
        const sub=i.options.getSubcommand(),code=i.options.getString("code").toUpperCase();
        if(sub==="create"){
          const coins=i.options.getInteger("coins");
          db.coupons[code]={coins,usedBy:[]};save();
          return i.reply(`✅ تم إنشاء \`${code}\` بقيمة **${coins} Coin**.`);
        }
        delete db.coupons[code];save();
        return i.reply(`✅ تم حذف \`${code}\`.`);
      }

      if(n==="couponuse"){
        const code=i.options.getString("code").toUpperCase(),c=db.coupons[code];
        if(!c)return i.reply({content:"❌ الكوبون غير موجود.",ephemeral:true});
        if(c.usedBy.includes(i.user.id))return i.reply({content:"❌ استخدمت الكوبون من قبل.",ephemeral:true});
        getUser(i.user.id).coins+=c.coins;c.usedBy.push(i.user.id);save();
        return i.reply({content:`🎁 أضيف **${c.coins} Coin** لرصيدك.`,ephemeral:true});
      }

      if(n==="request"){
        const coins=i.options.getInteger("coins"),guildId=i.options.getString("guild_id");
        const u=getUser(i.user.id);
        if(!u.oauth?.consented)return i.reply({content:"❌ لازم تعمل «إثبات نفسك» أولًا.",ephemeral:true});
        if(u.coins<coins)return i.reply({content:"❌ رصيدك غير كافٍ.",ephemeral:true});

        const id=`${Date.now()}-${i.user.id}`;
        db.requests[id]={
          id,userId:i.user.id,coins,guildId,status:"pending_owner",
          createdAt:new Date().toISOString()
        };
        save();
        await sendOwnerRequest(id);

        return i.reply({
          content:`📋 تم إنشاء الطلب **${id}**.\n⏳ حالته الآن: **بانتظار موافقة الـOwner**.`,
          ephemeral:true
        });
      }

      if(n==="requests"){
        if(!ownerOnly(i))return i.reply({content:"❌ Owner فقط.",ephemeral:true});
        const pending=Object.values(db.requests).filter(r=>r.status==="pending_owner");
        if(!pending.length)return i.reply({content:"لا توجد طلبات معلقة.",ephemeral:true});
        return i.reply({
          content:pending.slice(0,20).map(r=>`• \`${r.id}\` — <@${r.userId}> — ${r.coins} Coin — Guild \`${r.guildId}\``).join("\n"),
          ephemeral:true
        });
      }

      if(n==="refresh"){
        if(!ownerOnly(i))return i.reply({content:"❌ Owner فقط.",ephemeral:true});
        const us=Object.values(db.users);
        const linked=us.filter(x=>x.oauth?.consented).length;
        const pending=Object.values(db.requests).filter(x=>x.status==="pending_owner").length;
        const coins=us.reduce((a,x)=>a+Number(x.coins||0),0);
        return i.reply(`📊 **Refresh**\n👤 الحسابات المرتبطة: **${linked}**\n💰 مجموع Coins: **${coins}**\n📋 الطلبات المعلقة: **${pending}**`);
      }
    }

    if(i.isButton()){
      if(i.customId==="balance")
        return i.reply({content:`💰 رصيدك: **${getUser(i.user.id).coins} Coin**`,ephemeral:true});

      if(i.customId==="verify"){
        const base=process.env.OAUTH_REDIRECT_URI.replace(/\/callback$/,"");
        return i.reply({
          content:`🔐 اضغط هنا لإثبات نفسك وربط حسابك مع Discord:\n${base}/oauth?user=${i.user.id}`,
          ephemeral:true
        });
      }

      if(i.customId==="open_ticket"){
        const old=i.guild.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.name===`ticket-${i.user.id}`);
        if(old)return i.reply({content:`🎫 عندك تذكرة: ${old}`,ephemeral:true});

        const overwrites=[
          {id:i.guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},
          {id:i.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]}
        ];
        if(process.env.OWNER_ID)overwrites.push({
          id:process.env.OWNER_ID,
          allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]
        });

        const ch=await i.guild.channels.create({
          name:`ticket-${i.user.id}`,type:ChannelType.GuildText,
          parent:db.settings.ticketCategoryId||undefined,
          permissionOverwrites:overwrites
        });
        db.tickets[ch.id]={userId:i.user.id,createdAt:new Date().toISOString()};
        save();
        return i.reply({content:`🎫 تم فتح التذكرة: ${ch}`,ephemeral:true});
      }

      if(i.customId==="new_request"){
        return i.reply({
          content:"استخدم `/request` لإرسال طلب بعد إثبات نفسك.",
          ephemeral:true
        });
      }

      if(i.customId.startsWith("approve:")||i.customId.startsWith("reject:")){
        if(!ownerOnly(i))return i.reply({content:"❌ Owner فقط.",ephemeral:true});

        const [action,id]=i.customId.split(":");
        const r=db.requests[id];
        if(!r)return i.reply({content:"❌ الطلب غير موجود.",ephemeral:true});
        if(r.status!=="pending_owner")
          return i.reply({content:`❌ الطلب حالته بالفعل: ${r.status}`,ephemeral:true});

        r.status=action==="approve"?"approved":"rejected";
        r.reviewedAt=new Date().toISOString();
        r.reviewedBy=i.user.id;
        save();

        const requester=await client.users.fetch(r.userId).catch(()=>null);
        if(requester){
          await requester.send(
            action==="approve"
              ? `✅ تمت الموافقة على طلبك \`${id}\` من الـOwner.`
              : `❌ تم رفض طلبك \`${id}\` من الـOwner.`
          ).catch(()=>{});
        }

        return i.update({
          content:`${action==="approve"?"✅ تمت الموافقة":"❌ تم الرفض"} على الطلب \`${id}\`.`,
          embeds:[],components:[]
        });
      }
    }
  }catch(e){
    console.error(e);
    if(!i.replied&&!i.deferred)await i.reply({content:"❌ حدث خطأ.",ephemeral:true}).catch(()=>{});
  }
});

process.on("unhandledRejection",console.error);
process.on("uncaughtException",console.error);
client.login(process.env.DISCORD_TOKEN);

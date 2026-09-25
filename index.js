require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
  PermissionsBitField
} = require("discord.js");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = path.join(__dirname, "..", "data", "data.json");

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return {users:{},coupons:{},requests:{},stock:0,coinPrice:Number(process.env.COIN_PRICE||100000),nextRequest:1}; }
}
let db = load();
function save(){ fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); }

const client = new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials:[Partials.Channel]
});

const ownerOnly = id => id === process.env.OWNER_ID;
const money = n => Number(n).toLocaleString("en-US");
const userData = id => db.users[id] ||= {coins:0, verified:false, username:"", linkedAt:null};

function mainPanel(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("open_ticket").setLabel("فتح تيكت").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("stock").setLabel("الاستوك").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("buy_coins").setLabel("شراء كوينز").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("buy_members").setLabel("شراء الأعضاء").setStyle(ButtonStyle.Danger)
  );
}

function ticketPanel(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("stock").setLabel("الاستوك").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("buy_coins").setLabel("شراء كوينز").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("buy_members").setLabel("شراء الأعضاء").setStyle(ButtonStyle.Danger)
  );
}

function buyMembersModal(){
  return new ModalBuilder().setCustomId("buy_members_modal").setTitle("شراء الأعضاء").addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("quantity").setLabel("عدد الأعضاء").setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("guild_id").setLabel("Server ID").setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("coupon").setLabel("كود الخصم (اختياري)").setStyle(TextInputStyle.Short).setRequired(false)
    )
  );
}

const commands = [
  new SlashCommandBuilder().setName("panel").setDescription("إرسال لوحة المتجر"),
  new SlashCommandBuilder().setName("balance").setDescription("رصيدك"),
  new SlashCommandBuilder().setName("price").setDescription("عرض سعر الكوين"),
  new SlashCommandBuilder().setName("refresh").setDescription("إحصائيات المتجر")
].map(x=>x.toJSON());

async function registerCommands(){
  const rest = new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {body:commands});
}

client.once("ready", async ()=>{
  console.log(`Logged in as ${client.user.tag}`);
  try { await registerCommands(); } catch(e){ console.error("Command registration:",e.message); }
});

client.on("guildMemberAdd", async member=>{
  if(member.guild.id !== process.env.GUILD_ID) return;
  try{
    await member.send(
      `أهلاً ${member.user.username} 👋\n\n`+
      `لقد حصلت على مكافأة قدرها **100,000,000 credits**.\n`+
      `لاستلام/تفعيل المكافأة، اضغط الزر ثم اربط حسابك مع البوت.`
    );
    await member.send({components:[
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("إثبات نفسك").setStyle(ButtonStyle.Link)
          .setURL(`${process.env.OAUTH_PUBLIC_URL || process.env.OAUTH_REDIRECT_URI.replace(/\/callback$/,"")}/oauth?user=${member.id}`)
      )
    ]});
  }catch{}
});

app.get("/oauth",(req,res)=>{
  const user=req.query.user;
  if(!user) return res.status(400).send("Missing user.");
  const params=new URLSearchParams({
    client_id:process.env.CLIENT_ID,
    response_type:"code",
    redirect_uri:process.env.OAUTH_REDIRECT_URI,
    scope:"identify guilds.join",
    state:String(user)
  });
  res.redirect("https://discord.com/oauth2/authorize?"+params.toString());
});

app.get("/callback",async(req,res)=>{
  const {code,state}=req.query;
  if(!code) return res.status(400).send("Missing OAuth code.");
  try{
    const body=new URLSearchParams({
      client_id:process.env.CLIENT_ID,
      client_secret:process.env.OAUTH_CLIENT_SECRET,
      grant_type:"authorization_code",
      code:String(code),
      redirect_uri:process.env.OAUTH_REDIRECT_URI
    });
    const tokenRes=await fetch("https://discord.com/api/oauth2/token",{
      method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body
    });
    const token=await tokenRes.json();
    if(!token.access_token) return res.status(400).send("OAuth failed.");
    const meRes=await fetch("https://discord.com/api/users/@me",{headers:{Authorization:`Bearer ${token.access_token}`}});
    const me=await meRes.json();
    const u=userData(me.id);
    u.verified=true; u.username=me.username; u.linkedAt=new Date().toISOString();
    u.scopes=["identify","guilds.join"];
    save();
    res.send("تم إثبات وربط حسابك بنجاح ✅ يمكنك الرجوع إلى Discord الآن.");
  }catch(e){ console.error(e); res.status(500).send("OAuth error."); }
});

app.listen(PORT,()=>console.log(`Web server listening on ${PORT}`));

client.on("interactionCreate", async i=>{
  try{
    if(i.isChatInputCommand()){
      if(i.commandName==="panel"){
        if(!ownerOnly(i.user.id)) return i.reply({content:"هذا الأمر للمالك فقط.",ephemeral:true});
        return i.reply({content:"🛒 **متجر البوت**\nاختر الخدمة من الأزرار:",components:[mainPanel()]});
      }
      if(i.commandName==="balance"){
        return i.reply({content:`💰 رصيدك: **${money(userData(i.user.id).coins)} كوين**`,ephemeral:true});
      }
      if(i.commandName==="price"){
        return i.reply({content:`💵 سعر الكوين: **${money(db.coinPrice)}**`,ephemeral:true});
      }
      if(i.commandName==="refresh"){
        if(!ownerOnly(i.user.id)) return i.reply({content:"للمالك فقط.",ephemeral:true});
        const verified=Object.values(db.users).filter(x=>x.verified).length;
        return i.reply({content:`📊 Verified: **${verified}**\n📦 Stock: **${db.stock}**\n💵 Coin price: **${money(db.coinPrice)}**\n📝 Requests: **${Object.keys(db.requests).length}**`,ephemeral:true});
      }
    }

    if(!i.isButton() && !i.isModalSubmit()) return;

    if(i.isButton()){
      if(i.customId==="stock")
        return i.reply({content:`📦 الاستوك الحالي: **${db.stock}**\n👤 الحسابات الموثقة: **${Object.values(db.users).filter(x=>x.verified).length}**`,ephemeral:true});

      if(i.customId==="open_ticket")
        return i.reply({content:"🎫 تم فتح لوحة التيكت. اختر الخدمة من الأزرار بالأسفل.",components:[ticketPanel()],ephemeral:true});

      if(i.customId==="buy_coins"){
        const m=new ModalBuilder().setCustomId("buy_coins_modal").setTitle("شراء كوينز").addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("amount").setLabel("عدد الكوينز").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return i.showModal(m);
      }

      if(i.customId==="buy_members") return i.showModal(buyMembersModal());

      if(i.customId.startsWith("approve_") || i.customId.startsWith("reject_")){
        if(!ownerOnly(i.user.id)) return i.reply({content:"للمالك فقط.",ephemeral:true});
        const id=i.customId.split("_")[1], r=db.requests[id];
        if(!r) return i.reply({content:"الطلب غير موجود.",ephemeral:true});
        if(r.status!=="pending_owner") return i.reply({content:"تم التعامل مع الطلب مسبقاً.",ephemeral:true});
        if(i.customId.startsWith("approve_")){
          r.status="approved_manual_review"; r.approvedAt=new Date().toISOString();
          save();
          const u=userData(r.userId);
          const memberCost=r.quantity*db.coinPrice;
          try{ await client.users.send(r.userId,`✅ تم اعتماد طلبك #${id}.\nالكمية: ${r.quantity}\nالخادم: ${r.guildId}\nالتكلفة: ${money(memberCost)} كوين.\nالحالة: موافقة يدوية — لا يتم إضافة أعضاء تلقائياً في هذه النسخة.`); }catch{}
          return i.update({content:`✅ تم اعتماد الطلب #${id}.`,components:[]});
        } else {
          r.status="rejected"; r.rejectedAt=new Date().toISOString(); save();
          try{ await client.users.send(r.userId,`❌ تم رفض طلبك #${id}.`); }catch{}
          return i.update({content:`❌ تم رفض الطلب #${id}.`,components:[]});
        }
      }
    }

    if(i.isModalSubmit()){
      if(i.customId==="buy_coins_modal"){
        const amount=Number(i.fields.getTextInputValue("amount"));
        if(!Number.isInteger(amount)||amount<=0) return i.reply({content:"اكتب عدد كوينز صحيح.",ephemeral:true});
        const total=amount*db.coinPrice;
        return i.reply({content:`💳 لتحويل قيمة الشراء:\n\`#credit ${process.env.CREDIT_RECIPIENT_ID || "OWNER_ID"} ${total}\`\n\nبعد التحويل، أرسل إثبات الدفع للمالك. لا يتم تأكيد الدفع تلقائياً في هذه النسخة.`,ephemeral:true});
      }

      if(i.customId==="buy_members_modal"){
        const quantity=Number(i.fields.getTextInputValue("quantity"));
        const guildId=i.fields.getTextInputValue("guild_id").trim();
        const coupon=(i.fields.getTextInputValue("coupon")||"").trim();
        const u=userData(i.user.id);
        if(!Number.isInteger(quantity)||quantity<=0) return i.reply({content:"عدد الأعضاء غير صحيح.",ephemeral:true});
        if(!/^\d{15,22}$/.test(guildId)) return i.reply({content:"Server ID غير صحيح.",ephemeral:true});

        let discount=0;
        if(coupon){
          const c=db.coupons[coupon.toUpperCase()];
          if(!c || (c.usesLeft!==null && c.usesLeft<=0)) return i.reply({content:"الكوبون غير صالح.",ephemeral:true});
          discount=Math.min(100,Math.max(0,Number(c.discount||0)));
        }
        const gross=quantity*db.coinPrice;
        const cost=Math.floor(gross*(100-discount)/100);
        if(u.coins<cost) return i.reply({content:`رصيدك غير كافٍ. تحتاج ${money(cost)} كوين.`,ephemeral:true});
        if(db.stock<quantity) return i.reply({content:`الاستوك غير كافٍ. المتاح: ${db.stock}`,ephemeral:true});

        const id=String(db.nextRequest++);
        db.requests[id]={id,userId:i.user.id,quantity,guildId,coupon,discount,cost,status:"pending_owner",createdAt:new Date().toISOString()};
        save();

        const owner=await client.users.fetch(process.env.OWNER_ID).catch(()=>null);
        if(owner) await owner.send({
          content:`🛒 طلب شراء جديد #${id}\nالعميل: <@${i.user.id}>\nالكمية: ${quantity}\nServer ID: ${guildId}\nالتكلفة: ${money(cost)} كوين\nالخصم: ${discount}%`,
          components:[new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_${id}`).setLabel("موافقة").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_${id}`).setLabel("رفض").setStyle(ButtonStyle.Danger)
          )]
        });
        return i.reply({content:`📨 تم إرسال الطلب #${id} للمالك للمراجعة.\nالسعر: **${money(cost)} كوين**`,ephemeral:true});
      }
    }
  } catch(e){ console.error(e); if(!i.replied&&!i.deferred) await i.reply({content:"حدث خطأ غير متوقع.",ephemeral:true}).catch(()=>{}); }
});

async function prefixHandler(message){
  if(message.author.bot || !message.content.startsWith("+")) return;
  const [cmd,...args]=message.content.trim().split(/\s+/);
  if(!ownerOnly(message.author.id)) return message.reply("هذا الأمر للمالك فقط.");

  if(cmd==="+give"){
    const user=message.mentions.users.first(), amount=Number(args[1]);
    if(!user||!Number.isFinite(amount)||amount<=0) return message.reply("الاستخدام: +give @user amount");
    userData(user.id).coins+=amount; save(); return message.reply(`تم إضافة ${money(amount)} كوين لـ <@${user.id}>.`);
  }
  if(cmd==="-remove"){
    const user=message.mentions.users.first(), amount=Number(args[1]);
    if(!user||!Number.isFinite(amount)||amount<=0) return message.reply("الاستخدام: -remove @user amount");
    userData(user.id).coins=Math.max(0,userData(user.id).coins-amount); save(); return message.reply(`تم خصم ${money(amount)} كوين من <@${user.id}>.`);
  }
  if(cmd==="+price"){
    const amount=Number(args[0]); if(!Number.isFinite(amount)||amount<=0) return message.reply("الاستخدام: +price amount");
    db.coinPrice=amount; save(); return message.reply(`تم تغيير السعر إلى ${money(amount)}.`);
  }
  if(cmd==="+add"){
    const guildId=args[0], quantity=Number(args[1]);
    if(!guildId||!Number.isInteger(quantity)||quantity<=0) return message.reply("الاستخدام: +add SERVER_ID quantity");
    db.stock+=quantity; save(); return message.reply(`تم تسجيل إضافة ${quantity} إلى الاستوك للسيرفر ${guildId}.`);
  }
  if(cmd==="+coupon"){
    const code=(args[0]||"").toUpperCase(), discount=Number(args[1]), uses=args[2]===undefined?null:Number(args[2]);
    if(!code||!Number.isFinite(discount)||discount<0||discount>100) return message.reply("الاستخدام: +coupon CODE DISCOUNT [USES]");
    db.coupons[code]={discount,usesLeft:Number.isFinite(uses)?uses:null}; save(); return message.reply(`تم إنشاء الكوبون ${code}.`);
  }
  if(cmd==="+delcoupon"){
    const code=(args[0]||"").toUpperCase(); delete db.coupons[code]; save(); return message.reply(`تم حذف الكوبون ${code}.`);
  }
  if(cmd==="+requests"){
    const rows=Object.values(db.requests).slice(-10).map(r=>`#${r.id} — ${r.quantity} — ${r.status}`).join("\n")||"لا توجد طلبات.";
    return message.reply("آخر الطلبات:\n"+rows);
  }
}
client.on("messageCreate", prefixHandler);

client.login(process.env.DISCORD_TOKEN);

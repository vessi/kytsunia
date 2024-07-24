import { Bot, InputFile } from "grammy";
import { readFileSync, writeFileSync } from "fs";
import { debounce } from "ts-debounce";
import { Rule } from "./rule";

const bot = new Bot(process.env.BOT_TOKEN ?? "")

const dynamicRules : Rule[] = []

const insults = JSON.parse(readFileSync("insults.json", "utf-8"));
const rulesText = readFileSync("rules.json", "utf-8");

JSON.parse(rulesText).forEach((rule: { regex: string, type: string, fileId: string }) => {
  switch (rule.type) {
    case "gif":
      dynamicRules.push(new Rule(new RegExp(rule.regex), (ctx) => { ctx.api.sendAnimation(ctx.chat?.id ?? 0, rule.fileId) }, { type: "gif", fileId: rule.fileId }));
      break;
    case "sticker":
      dynamicRules.push(new Rule(new RegExp(rule.regex), (ctx) => { ctx.api.sendSticker(ctx.chat?.id ?? 0, rule.fileId) }, { type: "sticker", fileId: rule.fileId }));
  }
})

const debouncedReply = debounce((ctx, mode, id) => {
  switch (mode) {
    case "gif":
      ctx.replyWithAnimation(id, {
        reply_to_message_id: ctx.message?.message_id
      });
      break;
    case "sticker":
      ctx.replyWithSticker(id, {
        reply_to_message_id: ctx.message?.message_id
      });
      break;
    default:
      break;
  }
}, 1000)

setInterval(() => {
  const ruleSet : { regex: string; type: string; fileId: string; }[] = [];
  dynamicRules.forEach((rule) => {
    ruleSet.push({ regex: rule.regex.source, type: rule.meta.type, fileId: rule.meta.fileId });
  })
  const ruleSetString = JSON.stringify(ruleSet);
  writeFileSync("rules.json", ruleSetString);
}, 5000);

const fixedRules = [
  (new Rule(/(К|к)ицюн(я|ю)!/, (ctx) => { ctx.react("🤔") })),
  (new Rule(/(К|к)ицюн(я|ю), ти людина чи компʼютер\?/, (ctx) => {
    const message_id = ctx.message?.message_id;
    ctx.reply("Я компʼютер!", { reply_to_message_id: message_id })
  })),
  (new Rule(/(К|к)ицюн(я|ю), де тривога?/, (ctx) => {
    const alerts = new URL("https://alerts.com.ua/map.png");
    const alertsFile = new InputFile(alerts, "alerts.png");
    if (ctx.chat) {
      ctx.api.sendPhoto(ctx.chat.id, alertsFile);
    }
  })),
  (new Rule(/(К|к)ицюн(я|ю), виховуй/, (ctx) => {
    const reply_id = ctx.message?.reply_to_message?.message_id ?? ctx.message?.message_id
    // Select random insult from insults array and reply to the message
    const insult = insults[Math.floor(Math.random() * insults.length)];
    ctx.reply(insult, { reply_to_message_id: reply_id });
  })),
  (new Rule(/(К|к)ицюн(я|ю), скажи в (-\d*) (.*)/, async (ctx, rule) => {
    const message = ctx.message?.text;
    const match = rule.regex.exec(message?? "");
    const chat_id = match?.[3];
    const what_to_say = match?.[4];
    await bot.api.sendMessage(chat_id ?? 0, what_to_say ?? "");
  })),
  (new Rule(/(К|к)ицюн(я|ю), запиши як (.*)\.гіф/, (ctx, rule) => {
    const message = ctx.message?.text;
    const match = rule.regex.exec(message ?? "");
    const gifName = match?.[3];
    const gif = ctx.message?.reply_to_message?.animation?.file_id;
    if (gif && gifName) {
      const newRule = new Rule(new RegExp(`${gifName}\.гіф`), (ctx) => { ctx.api.sendAnimation(ctx.chat?.id ?? 0, gif) }, { type: "gif", fileId: gif });
      dynamicRules.push(newRule);
      ctx.reply(`Записала як ${gifName}`, { reply_to_message_id: ctx.message?.message_id });
    }
  })),
  (new Rule(/(К|к)ицюн(я|ю), запиши як (.*)\.стікер/, (ctx, rule) => {
    const message = ctx.message?.text;
    const match = rule.regex.exec(message ?? "");
    const gifName = match?.[3];
    const gif = ctx.message?.reply_to_message?.sticker?.file_id;
    if (gif && gifName) {
      const newRule = new Rule(new RegExp(`${gifName}\.стікер`), (ctx) => { ctx.api.sendSticker(ctx.chat?.id ?? 0, gif) }, { type: "sticker", fileId: gif });
      dynamicRules.push(newRule);
      ctx.reply(`Записала як ${gifName}`, { reply_to_message_id: ctx.message?.message_id });
    }
  })),
  (new Rule(/(К|к)ицюн(я|ю), забудь (.*)\.гіф/, (ctx, rule) => {
    const message = ctx.message?.text;
    const match = rule.regex.exec(message ?? "");
    const oldRule = dynamicRules.find((rule) => rule.regex.source === `${match?.[3]}.гіф`);
    if (!oldRule) {
      ctx.reply("Такого правила немає", { reply_to_message_id: ctx.message?.message_id })
    } else {
      dynamicRules.splice(dynamicRules.indexOf(oldRule), 1);
      ctx.reply("Забула", { reply_to_message_id: ctx.message?.message_id })
    }
  })),
  (new Rule(/(К|к)ицюн(я|ю), забудь (.*)\.стікер/, (ctx, rule) => {
    const message = ctx.message?.text;
    const match = rule.regex.exec(message ?? "");
    const oldRule = dynamicRules.find((rule) => rule.regex.source === `${match?.[3]}.стікер`);
    if (!oldRule) {
      ctx.reply("Такого правила немає", { reply_to_message_id: ctx.message?.message_id })
    } else {
      dynamicRules.splice(dynamicRules.indexOf(oldRule), 1);
      ctx.reply("Забула", { reply_to_message_id: ctx.message?.message_id })
    }
  })),
  (new Rule(/(К|к)ицюн(я|ю), які знаєш гіфки\?/, (ctx) => {
    const gifs = dynamicRules.filter((rule) => rule.meta.type === "gif").map((rule) => rule.regex.source.replace(".гіф", ""));
    const gifsList = gifs.join("\n");
    if (gifsList === "") {
      ctx.reply("Список порожній", { reply_to_message_id: ctx.message?.message_id });
      return;
    }
    ctx.reply(gifsList, { reply_to_message_id: ctx.message?.message_id });
  })),
  (new Rule(/(К|к)ицюн(я|ю), які знаєш стікери\?/, (ctx) => {
    const stickers = dynamicRules.filter((rule) => rule.meta.type === "sticker").map((rule) => rule.regex.source.replace(".стікер", ""));
    const stickersList = stickers.join("\n");
    if (stickersList === "") {
      ctx.reply("Список порожній", { reply_to_message_id: ctx.message?.message_id });
      return;
    }
    ctx.reply(stickersList, { reply_to_message_id: ctx.message?.message_id });
  })),
  (new Rule(/(К|к)ицюн(я|ю), запишись!/, (ctx) => {
    ctx.reply("Дядя, ти дурак? Автоматично зберігаюсь вже", { reply_to_message_id: ctx.message?.message_id });
  })),
  (new Rule(/(К|к)ицюн(я|ю), список!/, (ctx) => {
    const list = fixedRules.concat(dynamicRules).map((rule) => rule.regex.source).join("\n");
    ctx.reply(list, { reply_to_message_id: ctx.message?.message_id });
  })),
  (new Rule(/https:\/\/(www\.)?instagram.com\/(.*)\/?/, (ctx, rule) => {
    const message = ctx.message?.text;
    const match = rule.regex.exec(message ?? "");
    if (match === null) {
      return;
    }
    ctx.reply(`https://ddinstagram.com/${match[2]}`, { reply_to_message_id: ctx.message?.message_id });
  })),
  (new Rule(/https:\/\/(www\.)?(x|twitter).com\/(.*)\/?/, (ctx, rule) => {
    const message = ctx.message?.text;
    const match = rule.regex.exec(message ?? "");
    if (match === null) {
      return;
    }
    ctx.reply(`https://fxtwitter.com/${match[3]}`, { reply_to_message_id: ctx.message?.message_id });
  })),
]

bot.on("message", async (ctx) => {
  console.log(ctx.message);
  if (ctx.message?.forward_origin?.type === "channel") {
    switch (ctx.message?.forward_origin?.chat.id) {
      case -1001049320233:
        debouncedReply(ctx, "gif", "CgACAgIAAxkBAAMyZhvcglG35KbZrvNN8k70TELlRfoAAuQtAAJQ3LlJOsR-fNtFEyU0BA");
        break;
      case -1001360737249:
        debouncedReply(ctx, "sticker", "CAACAgIAAxkBAANPZhwqWMsNeI3blUQrTDxXWxGj-TEAAtVAAAJlqAhLXy-cMxg3dys0BA");
        break;
      case -1001536630827:
        debouncedReply(ctx, "sticker", "CAACAgIAAxkBAANUZhwsDlXK63Vp3pbvT7PZfNh1QVIAApBGAAKP5ghI6Q_53Kwo-Ug0BA");
        break;
      default:
        break;
    }
    return;
  };
  const rule = fixedRules.concat(dynamicRules).find((rule) => rule.check(ctx?.message?.text ?? ""));
  rule?.execute(ctx);
  return;
})

bot.start();

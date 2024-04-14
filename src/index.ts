import { Bot, InputFile } from "grammy";
import { Rule } from "./rule";
import { readFileSync, writeFileSync } from "fs";
import { debounce } from "ts-debounce";

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

const debouncedReply = debounce((ctx) => {
  ctx.replyWithAnimation("CgACAgIAAxkBAAMyZhvcglG35KbZrvNN8k70TELlRfoAAuQtAAJQ3LlJOsR-fNtFEyU0BA", { reply_to_message_id: ctx.message?.message_id });
}, 1000)

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
    const ruleSet : { regex: string; type: string; fileId: string; }[] = [];
    dynamicRules.forEach((rule) => {
      ruleSet.push({ regex: rule.regex.source, type: rule.meta.type, fileId: rule.meta.fileId });
    })
    const ruleSetString = JSON.stringify(ruleSet);
    writeFileSync("rules.json", ruleSetString);
    ctx.reply("Записалась!", { reply_to_message_id: ctx.message?.message_id });
  })),
  (new Rule(/(К|к)ицюн(я|ю), список!/, (ctx) => {
    const list = fixedRules.concat(dynamicRules).map((rule) => rule.regex.source).join("\n");
    ctx.reply(list, { reply_to_message_id: ctx.message?.message_id });
  })),
  (new Rule(/.*/, (ctx) => {
    console.log(ctx.message);
    if ((ctx.message?.forward_origin?.type === "channel") && (ctx.message?.forward_origin?.chat.id == -1001049320233)) {
      debouncedReply(ctx);
    }
  }))
]

bot.on("message", async (ctx) => {
  const rule = fixedRules.concat(dynamicRules).find((rule) => rule.check(ctx?.message?.text ?? ""));
  rule?.execute(ctx);
  return;
})

bot.start();

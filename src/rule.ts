import { Context } from "grammy";

class Rule {
  constructor(
    public readonly regex: RegExp,
    public readonly response: string | ((ctx: Context, rule: Rule) => void),
    public readonly meta: { type: "gif" | "text" | "sticker"; fileId: string } = { type: "text", fileId: "" }
  ) {
    this.regex = new RegExp(regex);
    this.response = response;
    this.meta = meta;
  }

  check(message:string): boolean {
    return this.regex.test(message);
  }

  execute(ctx: Context): void {
    if (typeof this.response === "string") {
      ctx.reply(this.response);
    } else {
      this.response(ctx, this);
    }
  }
}

export { Rule };

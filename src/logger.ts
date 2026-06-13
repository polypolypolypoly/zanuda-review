import pino from "pino";

// In local CLI mode logs must go to stderr so they don't pollute the review
// output on stdout. pino-pretty transport ignores the dest option, so we
// disable it entirely and write raw JSON to stderr instead.
const isLocalMode =
  process.env.PLATFORM === "local" || process.argv.includes("--local");

export const logger = isLocalMode
  ? pino({ level: process.env.LOG_LEVEL ?? "info" }, pino.destination(2))
  : pino({
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty", options: { colorize: true } },
    });

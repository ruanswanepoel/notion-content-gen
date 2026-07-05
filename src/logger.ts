export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "text" | "json";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LoggerOptions = {
  level?: LogLevel;
  format?: LogFormat;
};

export class Logger {
  level: LogLevel;
  format: LogFormat;

  constructor({ level = "info", format = "text" }: LoggerOptions = {}) {
    this.level = level;
    this.format = format;
  }

  child(overrides: LoggerOptions): Logger {
    return new Logger({
      level: overrides.level ?? this.level,
      format: overrides.format ?? this.format,
    });
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.emit("debug", msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.emit("info", msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.emit("warn", msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.emit("error", msg, meta);
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private emit(
    level: LogLevel,
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    if (!this.shouldLog(level)) return;
    const stream =
      level === "warn" || level === "error" ? process.stderr : process.stdout;

    if (this.format === "json") {
      const payload: Record<string, unknown> = {
        time: new Date().toISOString(),
        level,
        msg,
      };
      if (meta) Object.assign(payload, meta);
      stream.write(JSON.stringify(payload) + "\n");
      return;
    }

    const prefix = level === "info" ? "" : `[${level}] `;
    const suffix =
      meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    stream.write(`${prefix}${msg}${suffix}\n`);
  }
}

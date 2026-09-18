type LogLevel = "info" | "warn" | "error" | "fatal";

function log(
  level: LogLevel,
  event: string,
  data: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...data,
    })
  );
}

export const logger = {
  info: (event: string, data?: Record<string, unknown>) =>
    log("info", event, data),

  warn: (event: string, data?: Record<string, unknown>) =>
    log("warn", event, data),

  error: (event: string, data?: Record<string, unknown>) =>
    log("error", event, data),

  fatal: (event: string, data?: Record<string, unknown>) =>
    log("fatal", event, data),
};
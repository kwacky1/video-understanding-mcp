export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export const stderrLogger: Logger = {
  info(message) {
    process.stderr.write(`[video-understanding-mcp] ${message}\n`);
  },
  error(message) {
    process.stderr.write(`[video-understanding-mcp] ERROR ${message}\n`);
  },
};

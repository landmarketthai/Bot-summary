/**
 * Test-safe LINE adapter: records what WOULD be sent and never touches the
 * network. Used by unit tests and the Preview demo. Failures can be scripted
 * per call to exercise reply-token expiry, ambiguous replies and push retries.
 */
import { LineDeliveryError, type LineDeliveryAdapter } from "../delivery";

export interface RecordedLineMessage {
  channel: "reply" | "push";
  /** Reply token or push target. */
  target: string;
  text: string;
  retryKey?: string;
}

type Script = Array<
  | LineDeliveryError
  | "ok"
  | { delayMs: number }
  /** LINE accepted the push but the response was lost (network cut). */
  | { acceptedThenFail: LineDeliveryError }
>;

export class RecordingLineDelivery implements LineDeliveryAdapter {
  readonly sent: RecordedLineMessage[] = [];
  readonly attempts: RecordedLineMessage[] = [];
  private readonly acceptedRetryKeys = new Set<string>();
  replyScript: Script = [];
  pushScript: Script = [];

  private async run(script: Script, message: RecordedLineMessage, signal: AbortSignal): Promise<void> {
    this.attempts.push(message);
    const step = script.shift() ?? "ok";
    if (typeof step === "object" && "delayMs" in step) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new LineDeliveryError("ambiguous", null, message.channel === "push"));
        }, { once: true });
      });
    } else if (step instanceof LineDeliveryError) {
      throw step;
    }
  }

  async reply(replyToken: string, text: string, signal: AbortSignal): Promise<void> {
    const message: RecordedLineMessage = { channel: "reply", target: replyToken, text };
    await this.run(this.replyScript, message, signal);
    this.sent.push(message);
  }

  async push(to: string, text: string, retryKey: string, signal: AbortSignal): Promise<void> {
    const message: RecordedLineMessage = { channel: "push", target: to, text, retryKey };
    // Like LINE: a retry key that was already accepted is a 409, i.e. no second message.
    if (this.acceptedRetryKeys.has(retryKey)) {
      this.attempts.push(message);
      return;
    }
    const step = this.pushScript[0];
    if (step && typeof step === "object" && "acceptedThenFail" in step) {
      this.pushScript.shift();
      this.attempts.push(message);
      this.acceptedRetryKeys.add(retryKey);
      this.sent.push(message);
      throw step.acceptedThenFail;
    }
    await this.run(this.pushScript, message, signal);
    this.acceptedRetryKeys.add(retryKey);
    this.sent.push(message);
  }
}

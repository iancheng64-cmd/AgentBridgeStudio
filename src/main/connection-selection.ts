/** Tracks attempts for the current selection, without permanently blacklisting a
 * failed target. Changing away and back permits another automatic attempt. */
export class ConnectionSelection {
  private signature = "";
  private revision = 0;
  private attemptedRevision = -1;
  select(signature: string) {
    if (signature !== this.signature) { this.signature = signature; this.revision++; }
  }
  canAutoConnect() { return this.attemptedRevision !== this.revision; }
  begin() { this.attemptedRevision = this.revision; return this.revision; }
  isCurrent(attempt: number) { return attempt === this.revision; }
}

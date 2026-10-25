
export class TranscriptAccumulator {
  private fragments: string[] = [];

  // Add a new transcription fragment
  addFragment(text: string): void {
    if (!text.trim()) {
      return;
    }

    this.fragments.push(text);
  }

  // Return the accumulated text without clearing it
  getText(): string {
    return this.fragments.join("").trim();
  }

  // Return the complete response and reset
  flush(): string {
    const transcript = this.getText();

    this.fragments = [];

    return transcript;
  }

  // Check whether we have any text
  hasText(): boolean {
    return this.getText().length > 0;
  }

  // Discard the current fragments
  clear(): void {
    this.fragments = [];
  }
}

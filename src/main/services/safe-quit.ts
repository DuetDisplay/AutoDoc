/** Holds Electron's quit until the renderer and recording finalization have settled. */
export class SafeQuitCoordinator {
  private ready = false
  private pending = false

  constructor(
    private readonly options: {
      prepare: () => Promise<void>
      quit: () => void
      onError: (error: unknown) => void
    }
  ) {}

  allowQuit(): void {
    this.ready = true
  }

  cancelPreparedQuit(): void {
    this.ready = false
  }

  beforeQuit(event: { preventDefault: () => void }): boolean {
    if (this.ready) return true
    event.preventDefault()
    if (this.pending) return false
    this.pending = true
    void this.options
      .prepare()
      .then(() => {
        this.ready = true
        this.options.quit()
      })
      .catch((error: unknown) => {
        this.options.onError(error)
      })
      .finally(() => {
        this.pending = false
      })
    return false
  }
}

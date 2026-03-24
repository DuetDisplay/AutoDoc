import { spawn } from 'child_process'

export class AudioConverter {
  convert(inputPath: string, outputPath: string, ffmpegPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderr = ''

      const proc = spawn(ffmpegPath, [
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        '-y',
        outputPath,
      ])

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`))
        }
      })
    })
  }
}

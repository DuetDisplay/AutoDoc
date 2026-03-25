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

  /** Merge two audio files into one using amix filter */
  mergeAudio(input1: string, input2: string, outputPath: string, ffmpegPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, [
        '-i', input1,
        '-i', input2,
        '-filter_complex', 'amix=inputs=2:duration=longest',
        '-y',
        outputPath,
      ])
      let stderr = ''
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg merge exited with code ${code}: ${stderr.slice(-500)}`))
      })
    })
  }

  /** Get duration of audio file in seconds using ffprobe/ffmpeg */
  getDuration(inputPath: string, ffmpegPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      let stderr = ''
      const proc = spawn(ffmpegPath, ['-i', inputPath, '-f', 'null', '-'])
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      proc.on('close', () => {
        // Parse "Duration: HH:MM:SS.ss" from ffmpeg output
        const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
        if (match) {
          const hours = parseInt(match[1], 10)
          const mins = parseInt(match[2], 10)
          const secs = parseInt(match[3], 10)
          resolve(hours * 3600 + mins * 60 + secs)
        } else {
          reject(new Error('Could not determine audio duration'))
        }
      })
    })
  }
}

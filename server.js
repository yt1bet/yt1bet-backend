const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Write cookies file if env var exists
const COOKIES_PATH = path.join(os.tmpdir(), 'yt_cookies.txt');
if (process.env.YT_COOKIES) {
  fs.writeFileSync(COOKIES_PATH, process.env.YT_COOKIES);
  console.log('YouTube cookies loaded from environment');
}

function getCookiesArg() {
  if (fs.existsSync(COOKIES_PATH)) return `--cookies "${COOKIES_PATH}"`;
  return '';
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'yt-dlp server running' });
});

app.get('/download', async (req, res) => {
  const { url, format, quality } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-'));
  const outputTemplate = path.join(tmpDir, 'output.%(ext)s');
  const cookiesArg = getCookiesArg();

  // Common yt-dlp flags to bypass JS runtime check
  const commonFlags = `--extractor-args "youtube:player_client=android,web" --no-playlist ${cookiesArg}`;

  try {
    if (format === 'mp3') {
      // Audio extraction
      const outputPath = path.join(tmpDir, 'output.mp3');
      const cmd = `yt-dlp ${commonFlags} -x --audio-format mp3 --audio-quality 0 -o "${outputTemplate}" "${url}"`;

      await runCommand(cmd);

      const files = fs.readdirSync(tmpDir);
      const mp3File = files.find(f => f.endsWith('.mp3'));
      if (!mp3File) throw new Error('MP3 conversion failed');

      const filePath = path.join(tmpDir, mp3File);
      res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
      res.setHeader('Content-Type', 'audio/mpeg');

      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('end', () => cleanup(tmpDir));
      stream.on('error', () => cleanup(tmpDir));

    } else {
      // MP4 — merge video + audio with ffmpeg
      let formatSelector;
      if (quality === '1080p') {
        formatSelector = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
      } else if (quality === '720p') {
        formatSelector = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
      } else if (quality === '480p') {
        formatSelector = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]';
      } else {
        formatSelector = 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]';
      }

      const outputPath = path.join(tmpDir, 'output.mp4');
      const cmd = `yt-dlp ${commonFlags} -f "${formatSelector}" --merge-output-format mp4 -o "${outputPath}" "${url}"`;

      await runCommand(cmd);

      if (!fs.existsSync(outputPath)) {
        // Try fallback
        const fallbackCmd = `yt-dlp ${commonFlags} -f "best[ext=mp4]/best" -o "${outputPath}" "${url}"`;
        await runCommand(fallbackCmd);
      }

      if (!fs.existsSync(outputPath)) throw new Error('Video download failed');

      const stat = fs.statSync(outputPath);
      res.setHeader('Content-Disposition', `attachment; filename="video_${quality || '360p'}.mp4"`);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stat.size);

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on('end', () => cleanup(tmpDir));
      stream.on('error', () => cleanup(tmpDir));
    }
  } catch (err) {
    cleanup(tmpDir);
    console.error('Download error:', err.message);
    res.status(500).json({ error: err.message || 'Download failed' });
  }
});

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    console.log('Running:', cmd);
    exec(cmd, { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('stderr:', stderr);
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

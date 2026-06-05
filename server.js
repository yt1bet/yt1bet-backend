const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// YouTube client fallback order
const YT_CLIENTS = ['android_vr', 'android', 'mweb'];

function isYouTube(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

function isInstagram(url) {
  return url.includes('instagram.com');
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'yt-dlp server running' });
});

app.get('/download', async (req, res) => {
  const { url, format, quality } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-'));

  try {
    if (isInstagram(url)) {
      // Instagram — simple, no client args needed
      await downloadInstagram(url, format, quality, tmpDir, res);
    } else {
      // YouTube — try multiple clients
      await downloadYouTube(url, format, quality, tmpDir, res);
    }
  } catch (err) {
    cleanup(tmpDir);
    console.error('Download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Download failed' });
    }
  }
});

async function downloadInstagram(url, format, quality, tmpDir, res) {
  const commonFlags = `--no-playlist -q`;
  
  if (format === 'mp3') {
    const outputTemplate = path.join(tmpDir, 'output.%(ext)s');
    const cmd = `yt-dlp ${commonFlags} -x --audio-format mp3 --audio-quality 0 -o "${outputTemplate}" "${url}"`;
    await runCommand(cmd);

    const files = fs.readdirSync(tmpDir);
    const mp3File = files.find(f => f.endsWith('.mp3'));
    if (!mp3File) throw new Error('Audio extraction failed');

    const filePath = path.join(tmpDir, mp3File);
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('Content-Type', 'audio/mpeg');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => cleanup(tmpDir));
    stream.on('error', () => cleanup(tmpDir));

  } else {
    const outputPath = path.join(tmpDir, 'output.mp4');
    const cmd = `yt-dlp ${commonFlags} -f "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
    await runCommand(cmd);

    let finalFile = outputPath;
    if (!fs.existsSync(finalFile)) {
      const files = fs.readdirSync(tmpDir);
      const mp4File = files.find(f => f.endsWith('.mp4'));
      if (mp4File) finalFile = path.join(tmpDir, mp4File);
      else throw new Error('Video download failed');
    }

    const stat = fs.statSync(finalFile);
    res.setHeader('Content-Disposition', 'attachment; filename="reel.mp4"');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(finalFile);
    stream.pipe(res);
    stream.on('end', () => cleanup(tmpDir));
    stream.on('error', () => cleanup(tmpDir));
  }
}

async function downloadYouTube(url, format, quality, tmpDir, res) {
  let lastError = null;

  for (const client of YT_CLIENTS) {
    try {
      console.log(`Trying client: ${client}`);
      const commonFlags = `--extractor-args "youtube:player_client=${client}" --no-playlist -q`;

      if (format === 'mp3') {
        const outputTemplate = path.join(tmpDir, 'output.%(ext)s');
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
        return;

      } else {
        const outputPath = path.join(tmpDir, 'output.mp4');

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

        const cmd = `yt-dlp ${commonFlags} -f "${formatSelector}" --merge-output-format mp4 -o "${outputPath}" "${url}"`;
        await runCommand(cmd);

        let finalFile = outputPath;
        if (!fs.existsSync(finalFile)) {
          const files = fs.readdirSync(tmpDir);
          const mp4File = files.find(f => f.endsWith('.mp4'));
          if (mp4File) finalFile = path.join(tmpDir, mp4File);
          else throw new Error('Video download failed');
        }

        const stat = fs.statSync(finalFile);
        res.setHeader('Content-Disposition', `attachment; filename="video_${quality || '720p'}.mp4"`);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stat.size);
        const stream = fs.createReadStream(finalFile);
        stream.pipe(res);
        stream.on('end', () => cleanup(tmpDir));
        stream.on('error', () => cleanup(tmpDir));
        return;
      }

    } catch (err) {
      console.error(`Client ${client} failed:`, err.message);
      lastError = err;
      try { fs.readdirSync(tmpDir).forEach(f => fs.unlinkSync(path.join(tmpDir, f))); } catch {}
      continue;
    }
  }

  throw new Error(lastError?.message || 'All download methods failed');
}

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

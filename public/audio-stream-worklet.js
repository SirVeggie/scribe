/* Static module, served on both the shell and page origins. No device access here. */

/** Pure jitter-buffer step. Inputs are never modified; overflow drops old samples back to 60 ms. */
function audioJitterStep(state, incoming, length, rate) {
  let frames = state.frames.slice(), offset = state.offset, queued = state.queued, playing = state.playing;
  if (incoming?.length) { frames.push(incoming); queued += incoming.length; }
  const discard = count => {
    while (count > 0 && frames.length) {
      const n = Math.min(count, frames[0].length - offset);
      offset += n; queued -= n; count -= n;
      if (offset === frames[0].length) { frames.shift(); offset = 0; }
    }
  };
  if (queued > Math.round(rate * .2)) discard(queued - Math.round(rate * .06));
  if (!playing && queued >= Math.round(rate * .06)) playing = true;
  const output = new Float32Array(length);
  if (playing) {
    let written = 0;
    while (written < length && frames.length) {
      const n = Math.min(length - written, frames[0].length - offset);
      output.set(frames[0].subarray(offset, offset + n), written);
      discard(n); written += n;
    }
    if (!queued) playing = false; // Rebuffer after underrun instead of playing each packet late.
  }
  return { frames, offset, queued, playing, output };
}

class ScribeMicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(Math.round(sampleRate * .02));
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      this.frame[this.offset++] = sample / channels.length;
      if (this.offset === this.frame.length) {
        this.port.postMessage({ frame: this.frame.buffer }, [this.frame.buffer]);
        this.frame = new Float32Array(Math.round(sampleRate * .02)); this.offset = 0;
      }
    }
    return true; // Output stays silent: the shell must never monitor the microphone on speakers.
  }
}

class ScribeMicPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = { frames: [], offset: 0, queued: 0, playing: false };
    this.port.onmessage = event => {
      if (event.data?.frame instanceof ArrayBuffer) {
        this.buffer = audioJitterStep(this.buffer, new Float32Array(event.data.frame), 0, sampleRate);
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (output) {
      this.buffer = audioJitterStep(this.buffer, null, output.length, sampleRate);
      output.set(this.buffer.output);
    }
    return true;
  }
}
registerProcessor("scribe-mic-capture", ScribeMicCapture);
registerProcessor("scribe-mic-playback", ScribeMicPlayback);

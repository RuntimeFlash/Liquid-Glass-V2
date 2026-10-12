// What the speakers are playing, as the loudness of a few bands of
// frequencies, for the Now Playing card's bars. GStreamer reads the monitor of
// the default output and runs an FFT on it; the extension only reads the
// result.
import GLib from 'gi://GLib';
// Imported dynamically, so that the extension still loads where GStreamer's
// introspection data is not installed.
let Gst = null;
try {
    Gst = (await import('gi://Gst?version=1.0')).default;
}
catch {
    // AudioSpectrum.start() says so when it is first needed.
}
const RATE = 48000;
const BANDS = 256;
const INTERVAL_MS = 25;
const THRESHOLD_DB = -90;
// The bars' bands (Hz), low to high.
const RANGES = [[40, 150], [150, 400], [400, 1000], [1000, 2500], [2500, 7000]];
export const BAR_COUNT = RANGES.length;
// Music has less energy the higher it goes, about this much less per octave;
// it is given back so the high bars move as much as the low ones.
const TILT_DB_PER_OCTAVE = 4.5;
// The loudest bar sets the top of the scale, which falls this fast (dB/s)
// when the music gets quieter, and the bars show this many dB below it.
const CEILING_FALL_DB = 8;
const RANGE_DB = 42;
const MIN_CEILING_DB = -70;

/**
 * Listens while started, and calls `onLevels` with one level from 0 to 1 per
 * bar, low to high, every INTERVAL_MS.
 */
export class AudioSpectrum {
    _logger;
    _onLevels;
    _pipeline = null;
    _bus = null;
    _busId = 0;
    _ceiling = MIN_CEILING_DB;
    _lastUs = 0;
    // Bands per bar, [first, end).
    _bands;
    _tilt;
    // GStreamer lacks an element the pipeline needs; not tried again.
    _unavailable = false;

    constructor(_logger, _onLevels) {
        this._logger = _logger;
        this._onLevels = _onLevels;
        const width = RATE / 2 / BANDS;
        this._bands = RANGES.map(([lo, hi]) => {
            const first = Math.floor(lo / width);
            return [first, Math.max(Math.ceil(hi / width), first + 1)];
        });
        const centre = ([lo, hi]) => Math.sqrt(lo * hi);
        this._tilt = RANGES.map(r => TILT_DB_PER_OCTAVE * Math.log2(centre(r) / centre(RANGES[0])));
    }

    get listening() {
        return !!this._pipeline;
    }

    start() {
        if (this._pipeline || this._unavailable)
            return;
        if (!Gst) {
            this._unavailable = true;
            this._logger.log('[Liquid Glass] GStreamer is not installed; the media card\'s bars stay still');
            return;
        }
        if (!Gst.is_initialized())
            Gst.init(null);
        let pipeline;
        try {
            pipeline = Gst.parse_launch('pulsesrc device=@DEFAULT_MONITOR@ client-name="Liquid Glass" latency-time=10000 buffer-time=40000 ' +
                `! audio/x-raw,rate=${RATE},channels=1 ! audioconvert ` +
                `! spectrum bands=${BANDS} threshold=${THRESHOLD_DB} interval=${INTERVAL_MS * 1000000} ! fakesink sync=false`);
        }
        catch (e) {
            this._unavailable = true;
            this._logger.log(`[Liquid Glass] Cannot listen to the sound for the media card: ${e}`);
            return;
        }
        this._pipeline = pipeline;
        this._bus = pipeline.get_bus();
        this._bus.add_signal_watch();
        this._busId = this._bus.connect('message', (_bus, message) => this._message(message));
        this._lastUs = 0;
        pipeline.set_state(Gst.State.PLAYING);
    }

    stop() {
        if (!this._pipeline)
            return;
        this._bus.disconnect(this._busId);
        this._bus.remove_signal_watch();
        this._pipeline.set_state(Gst.State.NULL);
        this._pipeline = null;
        this._bus = null;
        this._busId = 0;
    }

    _message(message) {
        if (message.type === Gst.MessageType.ERROR) {
            const [error] = message.parse_error();
            this._logger.log(`[Liquid Glass] Stopped listening for the media card: ${error?.message}`);
            this.stop();
            return;
        }
        if (message.type !== Gst.MessageType.ELEMENT)
            return;
        const structure = message.get_structure();
        if (structure?.get_name() !== 'spectrum')
            return;
        const [ok, magnitudes] = structure.get_list('magnitude');
        if (!ok)
            return;
        const db = this._bands.map(([first, end], i) => {
            let power = 0;
            for (let b = first; b < end; b++)
                power += 10 ** (magnitudes.get_nth(b) / 10);
            return 10 * Math.log10(power / (end - first)) + this._tilt[i];
        });
        const now = GLib.get_monotonic_time();
        const dt = this._lastUs ? (now - this._lastUs) / 1e6 : 0;
        this._lastUs = now;
        this._ceiling = Math.max(this._ceiling - CEILING_FALL_DB * dt, ...db, MIN_CEILING_DB);
        this._onLevels(db.map(v => Math.min(Math.max((v - this._ceiling + RANGE_DB) / RANGE_DB, 0), 1) ** 1.5));
    }
}

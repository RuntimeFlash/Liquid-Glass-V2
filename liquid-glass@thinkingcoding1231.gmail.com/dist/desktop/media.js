import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { CARD_WIDTH, GlassCard } from './widgets.js';
import { addFrameTicker, removeFrameTicker } from '../animation/frames.js';
import { ContentLens } from '../rendering/contentLens.js';
import { verticalBoxParams } from '../shellVersion.js';
const ART_SIZE = 56;
const ART_RADIUS = 10;
// The bars beside the title (px): their width, the room between them, and
// how tall they are when silent and when loudest.
const BAR_WIDTH = 4;
const BAR_GAP = 4;
const BAR_MIN = 4;
const BAR_MAX = 30;
// How long (s) a bar takes to rise most of the way to a louder level, and to fall to a quieter one.
const BAR_RISE_S = 0.04;
const BAR_FALL_S = 0.16;
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

/**
 * The song or video that is playing (or was last), with buttons for the
 * previous track, play/pause and the next track. Talks to the players over
 * MPRIS directly; the card hides itself while no player is running.
 */
export class MediaWidget extends GlassCard {
    _art;
    _bars;
    _levels = new Array(BAR_COUNT).fill(0);
    _targets = new Array(BAR_COUNT).fill(0);
    _barsTickId = 0;
    _barsLastUs = 0;
    _spectrum;
    _settingsId;
    _title;
    _artist;
    _playButton;
    _players = new Map();
    _ownerChangedId = 0;
    _cancellable = new Gio.Cancellable();
    _current = null;

    constructor(env) {
        super('media', env, CARD_WIDTH);
        this.shown = false;
        const row = new St.BoxLayout({ style_class: 'lg-row' });
        this._art = new St.Icon({ icon_size: ART_SIZE, fallback_icon_name: 'audio-x-generic-symbolic' });
        const rounded = new ContentLens();
        this._art.add_effect(rounded);
        this._art.connect('notify::allocation', () => rounded.shape([0, 0, this._art.width, this._art.height], 1, ART_RADIUS, 0));
        const text = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, x_expand: true, ...verticalBoxParams() });
        this._title = new St.Label({ style_class: 'lg-title' });
        this._artist = new St.Label({ style_class: 'lg-dim' });
        for (const label of [this._title, this._artist])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._title);
        text.add_child(this._artist);
        this._bars = new St.DrawingArea({ width: BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP, height: BAR_MAX,
            y_align: Clutter.ActorAlign.CENTER });
        this._bars.connect('repaint', () => this._drawBars());
        // The bars are drawn in the title's color, which automatic contrast sets
        // on the labels only.
        this._title.connect('style-changed', () => this._bars.queue_repaint());
        row.add_child(this._art);
        row.add_child(text);
        row.add_child(this._bars);
        this._spectrum = new AudioSpectrum(env.logger, levels => {
            this._targets = levels;
            this._animateBars();
        });
        this._settingsId = env.settings.connect('changed::media-visualizer', () => this._update());
        const controls = new St.BoxLayout({ style_class: 'lg-controls', x_align: Clutter.ActorAlign.CENTER });
        const button = (icon, method) => {
            const b = new St.Button({ style_class: 'lg-control', can_focus: true,
                child: new St.Icon({ icon_name: icon, icon_size: 20 }) });
            b.connect('clicked', () => this._call(method));
            controls.add_child(b);
            return b;
        };
        button('media-skip-backward-symbolic', 'Previous');
        this._playButton = button('media-playback-start-symbolic', 'PlayPause');
        button('media-skip-forward-symbolic', 'Next');
        this.box.add_child(row);
        this.box.add_child(controls);
        this._ownerChangedId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
            const [name, , newOwner] = params.deepUnpack();
            if (!name.startsWith(MPRIS_PREFIX))
                return;
            if (newOwner)
                this._addPlayer(name);
            else
                this._removePlayer(name);
        });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
            try {
                const [names] = conn.call_finish(res).deepUnpack();
                for (const name of names)
                    if (name.startsWith(MPRIS_PREFIX))
                        this._addPlayer(name);
            }
            catch (e) {
                if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                    env.logger.log(`[Liquid Glass] Could not list media players: ${e}`);
            }
        });
    }

    _addPlayer(name) {
        if (this._players.has(name))
            return;
        const player = { name, proxy: null, changedId: 0, playedAt: 0 };
        this._players.set(name, player);
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, name, MPRIS_PATH, PLAYER_IFACE, this._cancellable, (_o, res) => {
            try {
                player.proxy = Gio.DBusProxy.new_for_bus_finish(res);
            }
            catch (e) {
                if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                    this.env.logger.log(`[Liquid Glass] Could not reach media player ${name}: ${e}`);
                return;
            }
            if (this._players.get(name) !== player)
                return;
            player.changedId = player.proxy.connect('g-properties-changed', () => this._update());
            this._update();
        });
    }

    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        this._players.delete(name);
        if (player.proxy && player.changedId)
            player.proxy.disconnect(player.changedId);
        if (this._current === player)
            this._current = null;
        this._update();
    }

    _property(player, name) {
        return player.proxy?.get_cached_property(name)?.recursiveUnpack() ?? null;
    }

    // The player that is playing, or the one that played last.
    _pick() {
        let best = null;
        const now = GLib.get_monotonic_time();
        for (const player of this._players.values()) {
            if (!player.proxy)
                continue;
            if (this._property(player, 'PlaybackStatus') === 'Playing')
                player.playedAt = now;
            if (!best || player.playedAt > best.playedAt)
                best = player;
        }
        return best;
    }

    _update() {
        const player = this._pick();
        this._current = player;
        const metadata = player ? this._property(player, 'Metadata') ?? {} : {};
        const title = metadata['xesam:title'] ?? '';
        const artists = metadata['xesam:artist'];
        this.shown = !!player && !!title;
        if (!this.shown) {
            this._listen(false);
            return;
        }
        this._title.text = title;
        this._artist.text = Array.isArray(artists) ? artists.join(', ') : (artists ?? '');
        const art = metadata['mpris:artUrl'] ?? '';
        this._art.gicon = art ? new Gio.FileIcon({ file: Gio.File.new_for_uri(art) }) : null;
        const playing = this._property(player, 'PlaybackStatus') === 'Playing';
        this._playButton.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._listen(playing);
        this.contentChanged();
    }

    // The bars follow the sound while a player plays, and lie down otherwise.
    _listen(playing) {
        const on = this.env.settings.get_boolean('media-visualizer');
        this._bars.visible = on;
        if (on && playing && this.shown) {
            this._spectrum.start();
            return;
        }
        this._spectrum.stop();
        this._targets = new Array(BAR_COUNT).fill(0);
        this._animateBars();
    }

    _animateBars() {
        if (this._barsTickId)
            return;
        this._barsLastUs = GLib.get_monotonic_time();
        this._barsTickId = addFrameTicker(() => {
            const now = GLib.get_monotonic_time();
            const dt = (now - this._barsLastUs) / 1e6;
            this._barsLastUs = now;
            let moving = false;
            this._levels = this._levels.map((level, i) => {
                const target = this._targets[i] ?? 0;
                const next = target + (level - target) * Math.exp(-dt / (target > level ? BAR_RISE_S : BAR_FALL_S));
                if (Math.abs(next - target) < 0.002)
                    return target;
                moving = true;
                return next;
            });
            this._bars.queue_repaint();
            if (moving || this._spectrum.listening)
                return true;
            this._barsTickId = 0;
            return false;
        }, 16);
    }

    // Rounded lines standing on the same baseline, in the title's color.
    _drawBars() {
        const cr = this._bars.get_context();
        const [, height] = this._bars.get_surface_size();
        const color = this._title.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(BAR_WIDTH);
        const cap = BAR_WIDTH / 2;
        this._levels.forEach((level, i) => {
            const x = i * (BAR_WIDTH + BAR_GAP) + cap;
            const h = BAR_MIN + (BAR_MAX - BAR_MIN) * level;
            cr.moveTo(x, height - cap);
            cr.lineTo(x, height - h + cap);
        });
        cr.stroke();
        cr.$dispose();
    }

    _call(method) {
        this._current?.proxy?.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    destroy() {
        this.env.settings.disconnect(this._settingsId);
        this._cancellable.cancel();
        if (this._ownerChangedId)
            Gio.DBus.session.signal_unsubscribe(this._ownerChangedId);
        this._ownerChangedId = 0;
        for (const name of [...this._players.keys()])
            this._removePlayer(name);
        this._spectrum.stop();
        if (this._barsTickId)
            removeFrameTicker(this._barsTickId);
        this._barsTickId = 0;
        super.destroy();
    }
}

// What the speakers are playing, as the loudness of a few bands of
// frequencies, for the Now Playing card's bars. GStreamer reads the monitor of
// the default output and runs an FFT on it; the extension only reads the
// result.
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
// A pipeline that fails, or goes quiet (the sound server restarted, the default output changed), is
// started again after this many seconds; the check for a silent one runs this often.
const RETRY_S = 2;
const WATCHDOG_S = 3;

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
    // Between start() and stop(), whether or not a pipeline is running right now.
    _wanted = false;
    _retryId = 0;
    _watchdogId = 0;
    _lastMessageUs = 0;

    constructor(_logger, _onLevels) {
        this._logger = _logger;
        this._onLevels = _onLevels;
        const width = RATE / 2 / BANDS;
        this._bands = RANGES.map(([lo, hi]) => {
            const first = Math.floor(lo / width);
            return [first, Math.max(Math.ceil(hi / width), first + 1)];
        });
        const center = ([lo, hi]) => Math.sqrt(lo * hi);
        this._tilt = RANGES.map(r => TILT_DB_PER_OCTAVE * Math.log2(center(r) / center(RANGES[0])));
    }

    get listening() {
        return !!this._pipeline;
    }

    start() {
        this._wanted = true;
        this._begin();
    }

    stop() {
        this._wanted = false;
        this._end();
    }

    _begin() {
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
        this._lastMessageUs = GLib.get_monotonic_time();
        pipeline.set_state(Gst.State.PLAYING);
        if (this._watchdogId)
            GLib.Source.remove(this._watchdogId);
        this._watchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, WATCHDOG_S, () => {
            if (GLib.get_monotonic_time() - this._lastMessageUs > WATCHDOG_S * 1e6)
                this._restart();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Stops the pipeline, and starts it again shortly if it is still wanted.
    _restart() {
        this._end();
        if (this._retryId)
            GLib.Source.remove(this._retryId);
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RETRY_S, () => {
            this._retryId = 0;
            if (this._wanted)
                this._begin();
            return GLib.SOURCE_REMOVE;
        });
    }

    _end() {
        if (this._watchdogId)
            GLib.Source.remove(this._watchdogId);
        this._watchdogId = 0;
        if (this._retryId)
            GLib.Source.remove(this._retryId);
        this._retryId = 0;
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
            this._logger.log(`[Liquid Glass] Lost the sound for the media card, trying again: ${error?.message}`);
            this._restart();
            return;
        }
        if (message.type !== Gst.MessageType.ELEMENT)
            return;
        this._lastMessageUs = GLib.get_monotonic_time();
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

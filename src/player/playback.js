(function() {
  var Playback = (function() {
    
    var events = null;
    
    var playback = {};
    
    // Boilerplate to connect this to a Notochord.
    playback.attachEvents = function(ev) {
      events = ev;
    };
    
    playback.ready = false;
    playback.midi = require('midi.js');
    playback.chordMagic = require('chord-magic');
    playback.tonal = require('tonal');
    playback.measureNumber = 0;
    playback.measure = null;
    playback.beat = 0;
    playback.playing = false;
    playback.tempo = 120; // Player should set these 3 before playing.
    playback.song = null;
    playback.beatLength = 500;
    /**
     * Perform an action in a certain number of beats.
     * @param {Function} func Function to run.
     * @param {Number|Number[]} durations Array of numbers of beats to wait to
     * run func.
     * @param {Boolean} [force=false] By default, won't run if playback.playing
     * is false at the specified time. Setting this to true ignres that.
     */
    playback.schedule = function(func, durations, force) {
      if (typeof durations == 'number') durations = [durations];
      for(let dur of durations) {
        if(dur === 0) {
          if(playback.playing || force) func();
        } else {
          setTimeout(() => {
            if(playback.playing || force) func();
          }, dur * playback.beatLength);
          // @todo swing?
        }
      }
    };
    /**
     * Turns a ChordMagic chord object into an array of note names.
     * @param {Object} chord ChordMagic chord object to analyze.
     * @param {Number} octave Octave to put the notes in.
     * @returns {Number[]} Array of note names.
     * @private
     */
    playback.chordToNotes = function(chord, octave) {
      var chordAsString = playback.chordMagic.prettyPrint(chord);
      var chordAsNoteNames = playback.tonal.chord(chordAsString);
      return chordAsNoteNames.map(note => note + octave);
    };
    /**
     * If theres a beat in the viewer, highlight it for the designated duration.
     * @param {Number} beatToHighlight Beat in the current measure to highlight.
     * @param {Number} beats How long to highlight the beat for, in beats.
     * @private
     */
    playback.highlightBeatForBeats = function(beatToHighlight, beats) {
      if(events) {
        var args = {
          measure: playback.measureNumber,
          beat: beatToHighlight
        };
        events.dispatch('Player.playBeat', args);
        playback.schedule(() => {
          events.dispatch('Player.stopBeat', args);
        }, beats, true); // force unhighlight after playback stops
      }
    };
    playback.instruments = new Map();
    playback.instrumentChannels = [];
    /**
     * Load the required instruments for a given style.
     * @param {String[]} newInstruments An array of instrument names.
     * @private
     */
    playback.requireInstruments = function(newInstruments) {
      // Avoid loading the same plugin twice.
      var safeInstruments = [];
      for (let instrument of newInstruments) {
        if(!playback.instruments.has(instrument)) {
          safeInstruments.push(instrument);
        }
      }
      
      // Load what's left.
      playback.midi.loadPlugin({
        soundfontUrl: 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/',
        instruments: safeInstruments,
        onsuccess: function() {
          for(let instrument of safeInstruments) {
            playback.instruments.set(
              instrument,
              playback.midi.GM.byName[instrument].number
            );
          }
          // Map each instrument to a MIDI channel.
          playback.instrumentChannels = [];
          for(let i in newInstruments) {
            let instrumentNumber = playback.instruments.get(
              newInstruments[i]
            );
            playback.midi.programChange(i, instrumentNumber);
            playback.instrumentChannels[instrumentNumber] = i;
          }
          playback.ready = true;
          events && events.dispatch('Player.loadStyle', {});
        }
      });
    };
    /**
     * Get the number of beats of rest left in the measure after (and including)
     * a given beat.
     * @param {Number} current Current beat.
     * @returns {Number} Number of beats of rest left, plus one.
     * @private
     */
    playback.restsAfter = function(current) {
      var measure = playback.song.measures[playback.measureNumber];
      if(measure) {
        let count = 1;
        for(let i = current + 1; i < measure.length; i++) {
          if(measure.getBeat(i)) {
            return count;
          } else {
            count++;
          }
        }
        return measure.length - current;
      } else {
        return 0;
      }
    };
    // Whether it's an even or odd measure.
    playback.evenMeasure = false;
    /**
     * Update playback.measure object to next measure.
     * @private
     */
    playback.nextMeasure = function() {
      playback.measureNumber++;
      if(playback.measureNumber < playback.song.measures.length) {
        var measure = playback.song.measures[playback.measureNumber];
        if(measure) {
          playback.evenMeasure = !playback.evenMeasure;
          playback.measure = measure;
        } else {
          playback.nextMeasure();
        }
      } else {
        playback.playing = false;
      }
    };
    /**
     * 
     */
    playback.nextBeat = function() {
      playback.beat++;
      if(playback.beat >= playback.measure.length) {
        playback.beat = 0;
      }
    };
    /**
     * Play a note or notes for a number of beats.
     * @param {Object} data Object with data about what to play.
     * @param {String|String[]} data.notes Note name[s] to play.
     * @param {String} data.instrument Instrument name to play notes on.
     * @param {Number} data.beats Number of beats to play the note for.
     * @param {Number} [data.velocity=100] Velocity (volume) for the notes.
     */
    // notes Array|Number
    playback.playNotes = function(data) {
      if(typeof data.notes == 'string') data.notes = [data.notes];
      var notesAsNums = data.notes.map(playback.tonal.note.midi);
      
      if(!data.velocity) data.velocity = 100;
      
      var instrumentNumber = playback.instruments.get(data.instrument);
      var channel = playback.instrumentChannels[instrumentNumber];
      
      playback.midi.chordOn(channel, notesAsNums, data.velocity, 0);
      playback.schedule(() => {
        // midi.js has the option to specify a delay, we're not using it.
        playback.midi.chordOff(channel, notesAsNums, 0);
      }, data.beats, true); // Force notes to end after playback stops.
    };
    
    // Also supply some drums.
    playback.drums = {};
    {
      let drums = require('./drums');
      for(let drumName in drums) {
        let data = drums[drumName];
        /**
         * Play a drum. Can be any of the following:
         * hatClosed, hatHalfOpen, snare1, kick, snare2, cymbal, tom, woodblock
         * @param {Number} [volume=0.5] Volume 0-1.
         */
        playback.drums[drumName] = function(volume = 0.5) {
          let audio = new Audio(data);
          audio.volume = volume;
          audio.play();
        };
      }
    }
    
    return playback;
  })();
  module.exports = Playback;
})();
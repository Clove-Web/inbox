/* sfx.js
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * Licensed under the DASL-1.0 Licence.
 * See LICENCE.md in the project root for full licence information.
 *
 * UI sounds: hover, click, toggle. On by default, muteable (persisted),
 * silenced under prefers-reduced-motion. Set window.SFX_BASE to point at the
 * folder holding hover.mp3 / click.mp3 / toggle.mp3 (defaults to "/sfx/").
 */
(function () {
  var base = window.SFX_BASE || "https://m.doughmination.gay/sfx/";

  var reduceMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  var STORE_KEY = "sfx-muted";

  function readMuted() {
    if (reduceMotion) return true;
    try {
      return localStorage.getItem(STORE_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  var muted = readMuted();

  var names = ["hover", "click", "toggle"];

  var sounds = {};
  names.forEach(function (name) {
    var audio = new Audio(base + name + ".mp3");
    audio.preload = "auto";
    audio.volume = 0.3;
    sounds[name] = audio;
  });

  var lastHover = 0;

  function play(name) {
    if (muted) return;
    var audio = sounds[name];
    if (!audio) return;
    try {
      audio.currentTime = 0;
      var attempt = audio.play();
      if (attempt && attempt.catch) attempt.catch(function () {});
    } catch (e) {}
  }

  var interactive = 'a,button,[role="button"],summary,.row,.copy,.zip';
  var toggleable = 'input[type="checkbox"],input[type="radio"],[role="switch"]';

  document.addEventListener(
    "pointerover",
    function (event) {
      var el = event.target.closest(interactive);
      if (!el) return;
      var now = Date.now();
      if (now - lastHover < 90) return;
      lastHover = now;
      play("hover");
    },
    true,
  );

  document.addEventListener(
    "click",
    function (event) {
      if (event.target.closest(toggleable)) {
        play("toggle");
        return;
      }
      if (event.target.closest(interactive)) play("click");
    },
    true,
  );

  document.addEventListener(
    "change",
    function (event) {
      if (event.target.matches(toggleable + ",select")) play("toggle");
    },
    true,
  );

  function label() {
    return muted ? "Unmute interface sounds" : "Mute interface sounds";
  }

  function glyph() {
    return muted ? "🔇" : "🔊";
  }

  function mount() {
    var button = document.querySelector(".sfx-toggle");
    if (!button) {
      button = document.createElement("button");
      button.className = "sfx-toggle";
      document.body.appendChild(button);
    }
    button.type = "button";
    button.textContent = glyph();
    button.setAttribute("aria-label", label());

    button.addEventListener("click", function () {
      muted = !muted;
      try {
        localStorage.setItem(STORE_KEY, muted ? "1" : "0");
      } catch (e) {}
      button.textContent = glyph();
      button.setAttribute("aria-label", label());
      if (!muted) play("toggle");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();

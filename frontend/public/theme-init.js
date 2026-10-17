/* global localStorage, window, document */
(function(){var t=localStorage.getItem('clipnest-theme')||'auto';if(t==='auto')t=window.matchMedia('(prefers-color-scheme:light)').matches?'light':'dark';document.documentElement.setAttribute('data-theme',t)})();

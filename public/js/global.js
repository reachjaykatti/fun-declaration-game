document.addEventListener("DOMContentLoaded", () => {
  const el = document.querySelector("body");
  if (el && el.dataset && el.dataset.fdHomeUrl) {
    window.fdHomeUrl = el.dataset.fdHomeUrl;
  }
});

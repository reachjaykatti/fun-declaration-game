document.addEventListener("DOMContentLoaded", () => {
  const el = document.querySelector("body");
  if (el && el.dataset && el.dataset.fdHomeUrl) {
    window.fdHomeUrl = el.dataset.fdHomeUrl;
  }
});
window.showChangePasswordForm = function () {
  const loginForm = document.getElementById("loginForm");
  const changeForm = document.getElementById("changePasswordForm");
  if (loginForm && changeForm) {
    loginForm.style.display = "none";
    changeForm.style.display = "block";
  }
};

window.showLoginForm = function () {
  const loginForm = document.getElementById("loginForm");
  const changeForm = document.getElementById("changePasswordForm");
  if (loginForm && changeForm) {
    changeForm.style.display = "none";
    loginForm.style.display = "block";
  }
};

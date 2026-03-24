document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("loginForm");
  const changeForm = document.getElementById("changePasswordForm");

  const changeBtn = document.querySelector('[onclick="showChangePasswordForm()"]');
  const backBtn = document.querySelector('[onclick="showLoginForm()"]');

  if (changeBtn) {
    changeBtn.onclick = () => {
      if (loginForm && changeForm) {
        loginForm.style.display = "none";
        changeForm.style.display = "block";
      }
    };
  }

  if (backBtn) {
    backBtn.onclick = () => {
      if (loginForm && changeForm) {
        changeForm.style.display = "none";
        loginForm.style.display = "block";
      }
    };
  }
});

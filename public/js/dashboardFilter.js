document.addEventListener("DOMContentLoaded", () => {
  const dropdown = document.getElementById("seriesId");
  if (!dropdown) return;

  dropdown.addEventListener("change", () => {
    const selected = dropdown.value;
    const url = selected ? `/dashboard?seriesId=${selected}` : '/dashboard';
    window.location.href = url;
  });
});

document.addEventListener("DOMContentLoaded", function () {
  const dropdown = document.getElementById("seriesId");
  if (!dropdown) {
    console.warn("⚠️ No seriesId dropdown found on page.");
    return;
  }

  console.log("✅ dashboardFilter.js active");

  dropdown.addEventListener("change", function () {
    const selected = this.value;
    console.log("🎯 Series selected:", selected);
    const url = selected ? `/dashboard?seriesId=${selected}` : '/dashboard';
    window.location.href = url;
  });
});

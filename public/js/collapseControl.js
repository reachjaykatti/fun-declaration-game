// public/js/collapseControl.js

document.addEventListener("DOMContentLoaded", () => {
  console.log("✅ collapseControl.js loaded and active");

  // Handle section title toggles (user view)
  document.querySelectorAll(".section-title").forEach(title => {
    title.style.cursor = "pointer";
    let icon = title.querySelector(".toggle-icon");

    if (!icon) {
      icon = document.createElement("span");
      icon.classList.add("toggle-icon");
      icon.textContent = " ▼";
      icon.style.fontSize = "0.8em";
      icon.style.opacity = "0.6";
      title.appendChild(icon);
    }

    title.addEventListener("click", () => {
      const section = title.closest(".section-block") || title.closest(".travel-section");
      if (!section) return;

      const grid = section.querySelector(".travel-grid");
      if (!grid) return;

      const isCollapsed = grid.style.display === "none";
      grid.style.display = isCollapsed ? "grid" : "none";
      icon.textContent = isCollapsed ? " ▼" : " ►";
    });
  });

  // Universal Collapse/Expand All
  const toggleBtn = document.getElementById("toggleAllSections");
  if (!toggleBtn) {
    console.log("⚠️ No collapse button found on this page");
    return;
  }

  let allCollapsed = false;

  toggleBtn.addEventListener("click", () => {
    console.log("🟢 Collapse/Expand button clicked");

    const grids = document.querySelectorAll(".travel-grid");
    if (!grids.length) {
      console.log("⚠️ No travel grids found");
      return;
    }

    allCollapsed = !allCollapsed;
    grids.forEach(grid => {
      grid.style.display = allCollapsed ? "none" : "grid";
    });

    const icons = document.querySelectorAll(".toggle-icon");
    icons.forEach(icon => {
      icon.textContent = allCollapsed ? " ►" : " ▼";
    });

    toggleBtn.textContent = allCollapsed ? "🔼 Expand All" : "🔽 Collapse All";
  });
});

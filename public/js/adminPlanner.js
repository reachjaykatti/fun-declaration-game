document.addEventListener('DOMContentLoaded', () => {
  console.log("✅ adminPlanner.js loaded");

  // Declare buttons
  document.querySelectorAll('.declare-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const matchId = btn.dataset.matchId;
      const winner = btn.dataset.winner;

      const c1 = confirm(`Are you sure you want to declare ${winner}?`);
      if (!c1) return;
      const c2 = confirm(`Final confirmation — Proceed to declare ${winner}?`);
      if (!c2) return;

      try {
        const res = await fetch(`/admin/matches/${matchId}/declare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ winner, washed_out: false })
        });
        const data = await res.json();
        alert(data.message || data.error);
        if (data.success) location.reload();
      } catch (err) {
        alert('❌ Something went wrong.');
        console.error(err);
      }
    });
  });

  // Washout buttons
  document.querySelectorAll('.declare-btn-washout').forEach(btn => {
    btn.addEventListener('click', async () => {
      const matchId = btn.dataset.matchId;

      const c1 = confirm('Are you sure you want to declare Washed Out?');
      if (!c1) return;
      const c2 = confirm('Final confirmation — Proceed to declare Washed Out?');
      if (!c2) return;

      try {
        const res = await fetch(`/admin/matches/${matchId}/declare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ washed_out: true })
        });
        const data = await res.json();
        alert(data.message || data.error);
        if (data.success) location.reload();
      } catch (err) {
        alert('❌ Something went wrong.');
        console.error(err);
      }
    });
  });

  // Cancel buttons
  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const matchId = btn.dataset.matchId;
      const c1 = confirm('Are you sure you want to cancel this travel?');
      if (!c1) return;
      const c2 = confirm('Final confirmation: Cancel this travel?');
      if (!c2) return;

      try {
        const res = await fetch(`/admin/matches/${matchId}/reset-ledger`, { method: 'POST' });
        const data = await res.json();
        alert(data.message || data.error);
        if (data.success) location.reload();
      } catch (err) {
        alert('❌ Failed to cancel travel.');
      }
    });
  });
});

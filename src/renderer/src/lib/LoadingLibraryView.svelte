<main>
  <div class="card">
    <div class="spinner" aria-hidden="true"></div>
    <p class="text">Loading your library…</p>
  </div>
</main>

<style>
  main {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    color: #a0a0a0;
  }

  .spinner {
    width: 36px;
    height: 36px;
    border: 3px solid #333;
    border-top-color: #c084fc;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }

  .text {
    margin: 0;
    font-size: 0.9rem;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

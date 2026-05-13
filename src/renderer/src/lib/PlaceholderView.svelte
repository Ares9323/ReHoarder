<script lang="ts">
  interface Props {
    title: string
    blurb: string
    /** Optional list of bullet points hinting at planned features. */
    planned?: string[]
  }
  let { title, blurb, planned = [] }: Props = $props()
</script>

<main>
  <div class="card">
    <h2>{title}</h2>
    <p class="blurb">{blurb}</p>
    {#if planned.length > 0}
      <h3>Planned</h3>
      <ul>
        {#each planned as p}
          <li>{p}</li>
        {/each}
      </ul>
    {/if}
    <p class="footer">Not implemented yet — tracked in the v0c+ roadmap.</p>
  </div>
</main>

<style>
  main {
    display: flex;
    justify-content: center;
    padding: 3rem 1.5rem;
  }
  .card {
    max-width: 640px;
    width: 100%;
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 1.75rem 2rem;
    color: #c0c0c0;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.2rem;
    color: #fff;
  }
  h3 {
    margin: 1.25rem 0 0.5rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: #c084fc;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .blurb {
    margin: 0 0 0.5rem;
    line-height: 1.45;
    color: #b0b0b0;
  }
  ul {
    margin: 0;
    padding-left: 1.2rem;
    line-height: 1.6;
  }
  li {
    color: #a8a8a8;
    font-size: 0.9rem;
  }
  .footer {
    margin: 1.25rem 0 0;
    font-size: 0.75rem;
    color: #666;
  }
</style>

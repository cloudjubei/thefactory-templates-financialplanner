const moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function formatPct(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

async function loadJson(path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`fetch ${path}: HTTP ${res.status}`)
  return res.json()
}

function renderHero(config) {
  const heading = document.getElementById('welcome-heading')
  const sub = document.getElementById('welcome-subheading')
  if (config && typeof config.welcomeHeading === 'string') heading.textContent = config.welcomeHeading
  if (config && typeof config.welcomeSubheading === 'string') sub.textContent = config.welcomeSubheading
}

function renderTopPicks(picks) {
  const body = document.getElementById('top-picks-body')
  body.innerHTML = ''
  if (!Array.isArray(picks) || picks.length === 0) {
    body.className = 'top-picks-empty'
    const p = document.createElement('p')
    p.textContent = 'Personalize via the first story to see picks tailored to your investment focus.'
    body.append(p)
    return
  }
  body.className = ''
  const list = document.createElement('ul')
  list.className = 'top-picks-list'
  for (const pick of picks) {
    const li = document.createElement('li')
    const sym = document.createElement('div')
    sym.className = 'pick-symbol'
    const name = pick.name ? ` — ${pick.name}` : ''
    sym.textContent = `${pick.symbol ?? ''}${name}`
    const reason = document.createElement('div')
    reason.className = 'pick-reason'
    reason.textContent = pick.reason ?? ''
    li.append(sym, reason)
    list.append(li)
  }
  body.append(list)
}

function renderHoldings(holdings) {
  const tbody = document.getElementById('holdings-body')
  tbody.innerHTML = ''
  let cost = 0
  let current = 0
  for (const h of holdings) {
    cost += Number(h.costBasis) || 0
    current += Number(h.currentValue) || 0
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${h.symbol ?? ''}</td>
      <td>${h.name ?? ''}</td>
      <td class="num">${h.quantity ?? 0}</td>
      <td class="num">${moneyFmt.format(Number(h.costBasis) || 0)}</td>
      <td class="num">${moneyFmt.format(Number(h.currentValue) || 0)}</td>
    `
    tbody.append(tr)
  }
  const pnl = current - cost
  const pnlPct = cost === 0 ? 0 : (pnl / cost) * 100
  document.getElementById('holdings-total').textContent = moneyFmt.format(current)
  const pnlEl = document.getElementById('holdings-pnl')
  pnlEl.textContent = `${moneyFmt.format(pnl)} (${formatPct(pnlPct)})`
  pnlEl.className = pnl >= 0 ? 'pnl-positive' : 'pnl-negative'
}

function projectBalance({ principal, monthly, annualReturnPct, years }) {
  const r = annualReturnPct / 100 / 12
  const labels = []
  const balances = []
  for (let y = 0; y <= years; y++) {
    const n = y * 12
    const compounded = principal * Math.pow(1 + r, n)
    const contributed = r === 0 ? monthly * n : monthly * ((Math.pow(1 + r, n) - 1) / r) * (1 + r)
    labels.push(`${y}y`)
    balances.push(compounded + contributed)
  }
  return { labels, balances, finalValue: balances[balances.length - 1] }
}

let calculatorChart

function renderCalculator() {
  const form = document.getElementById('calc-form')
  const projectionEl = document.getElementById('calc-projection')
  const canvas = document.getElementById('calc-chart')

  function recalc() {
    const principal = Number(document.getElementById('calc-principal').value) || 0
    const monthly = Number(document.getElementById('calc-monthly').value) || 0
    const annualReturnPct = Number(document.getElementById('calc-return').value) || 0
    const years = Math.max(1, Number(document.getElementById('calc-years').value) || 1)
    const { labels, balances, finalValue } = projectBalance({ principal, monthly, annualReturnPct, years })
    projectionEl.textContent = moneyFmt.format(finalValue)
    if (!window.Chart) return
    if (calculatorChart) {
      calculatorChart.data.labels = labels
      calculatorChart.data.datasets[0].data = balances
      calculatorChart.update()
    } else {
      calculatorChart = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'Projected balance',
              data: balances,
              borderColor: '#2563eb',
              backgroundColor: 'rgba(37, 99, 235, 0.12)',
              fill: true,
              tension: 0.25,
              pointRadius: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { ticks: { callback: (v) => moneyFmt.format(v) } },
          },
        },
      })
    }
  }

  form.addEventListener('input', recalc)
  recalc()
  // Chart.js loads with defer; ensure first draw runs once it's ready.
  if (!window.Chart) {
    const tick = () => (window.Chart ? recalc() : setTimeout(tick, 50))
    tick()
  }
}

async function init() {
  try {
    const [config, holdings, topPicks] = await Promise.all([
      loadJson('./data/config.json'),
      loadJson('./data/sample-holdings.json'),
      loadJson('./data/top-picks.json'),
    ])
    renderHero(config)
    renderHoldings(holdings)
    renderTopPicks(topPicks)
    renderCalculator()
  } catch (err) {
    const banner = document.createElement('pre')
    banner.style.cssText =
      'color:#dc2626;background:#fff;padding:12px;margin:0 0 16px;border:1px solid #fecaca;border-radius:8px;white-space:pre-wrap;'
    banner.textContent = `Failed to load template data: ${err && err.message ? err.message : err}\n\nThis template needs to be served over HTTP (e.g. \`python3 -m http.server\`) because the browser blocks file:// fetches.`
    document.body.prepend(banner)
  }
}

init()

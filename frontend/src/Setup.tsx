import { useState } from 'react'
import { SIDE_COLORS, type Rosters } from './teams'

const MAX_PER_TEAM = 4

const inputClass =
  'min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-base dark:border-stone-700 dark:bg-stone-900'

function TeamCard({ side, name, members, onName, onMembers }: {
  side: 0 | 1
  name: string
  members: string[]
  onName: (name: string) => void
  onMembers: (members: string[]) => void
}) {
  return (
    <fieldset
      className="flex flex-col gap-2 rounded-xl border-l-4 bg-white p-3 shadow-sm dark:bg-stone-900"
      style={{ borderLeftColor: SIDE_COLORS[side] }}
    >
      <legend className="sr-only">Team {side + 1}</legend>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Team {side + 1}{side === 0 && ' (breaks)'}
        <input value={name} placeholder={`Team ${side + 1}`} onChange={e => onName(e.target.value)} className={inputClass} />
      </label>
      <p className="text-xs text-stone-500">Players, in shooting order</p>
      {members.map((m, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            required={i === 0}
            aria-label={`Team ${side + 1} player ${i + 1}`}
            placeholder={`Player ${i + 1}`}
            value={m}
            onChange={e => onMembers(members.map((x, j) => (j === i ? e.target.value : x)))}
            className={inputClass}
          />
          {members.length > 1 && (
            <button
              type="button"
              aria-label={`Remove player ${i + 1}`}
              onClick={() => onMembers(members.filter((_, j) => j !== i))}
              className="flex size-11 shrink-0 items-center justify-center rounded-lg text-stone-500 active:bg-stone-200 dark:active:bg-stone-800"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          )}
        </div>
      ))}
      {members.length < MAX_PER_TEAM && (
        <button
          type="button"
          onClick={() => onMembers([...members, ''])}
          className="self-start py-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300"
        >
          + Add player
        </button>
      )}
    </fieldset>
  )
}

/** New game: two players, or two teams that take turns within the team. */
export function Setup({ onStart, busy }: { onStart: (names: [string, string], rosters: Rosters) => void; busy: boolean }) {
  const [teams, setTeams] = useState(false)
  const [names, setNames] = useState<[string, string]>(['', ''])
  const [members, setMembers] = useState<[string[], string[]]>([['', ''], ['', '']])

  function submit() {
    if (!teams) return onStart(names, null)
    const teamNames = names.map((n, i) => n.trim() || `Team ${i + 1}`) as [string, string]
    if (teamNames[0] === teamNames[1]) teamNames[1] += ' (2)' // the backend tells sides apart by name
    const rosters = members.map(list => list.map(m => m.trim()).filter(Boolean)) as [string[], string[]]
    onStart(teamNames, rosters)
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={e => {
        e.preventDefault()
        submit()
      }}
    >
      <div role="radiogroup" aria-label="Game type" className="grid grid-cols-2 gap-1 rounded-xl bg-stone-200 p-1 dark:bg-stone-800">
        {[false, true].map(isTeams => (
          <button
            key={String(isTeams)}
            type="button"
            role="radio"
            aria-checked={teams === isTeams}
            onClick={() => setTeams(isTeams)}
            className={`rounded-lg px-2 py-2 text-sm font-semibold ${
              teams === isTeams
                ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-950 dark:text-stone-100'
                : 'text-stone-600 dark:text-stone-400'
            }`}
          >
            {isTeams ? 'Teams' : '1 vs 1'}
          </button>
        ))}
      </div>

      <p className="text-sm text-stone-600 dark:text-stone-400">
        {teams
          ? '8-ball, two teams. Teammates take turns each time their team comes to the table.'
          : '8-ball, two players. The coach remembers each player across games, so use the same names next time.'}
      </p>

      {teams
        ? ([0, 1] as const).map(side => (
          <TeamCard
            key={side}
            side={side}
            name={names[side]}
            members={members[side]}
            onName={n => setNames(prev => (side === 0 ? [n, prev[1]] : [prev[0], n]))}
            onMembers={list => setMembers(prev => (side === 0 ? [list, prev[1]] : [prev[0], list]))}
          />
        ))
        : ([0, 1] as const).map(i => (
          <label key={i} className="flex flex-col gap-1 text-sm font-medium">
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ background: SIDE_COLORS[i] }} aria-hidden="true" />
              {i === 0 ? 'Player 1 (breaks)' : 'Player 2'}
            </span>
            <input
              required
              value={names[i]}
              onChange={e => setNames(n => (i === 0 ? [e.target.value, n[1]] : [n[0], e.target.value]))}
              className={inputClass}
            />
          </label>
        ))}

      <button
        disabled={busy}
        className="rounded-xl bg-emerald-700 px-5 py-3 text-lg font-semibold text-white active:bg-emerald-800 disabled:opacity-60"
      >
        {busy ? 'Starting…' : 'Start game'}
      </button>
    </form>
  )
}

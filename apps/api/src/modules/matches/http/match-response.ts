import type { Match, MatchScore, MatchStatus } from '../domain/match.js';

export interface MatchResponse {
  id: string;
  homeTeam: string;
  homeTeamId: string;
  awayTeam: string;
  awayTeamId: string;
  kickoffAt: string;
  status: MatchStatus;
  /** `null` cuando el partido no tiene resultado. */
  score: MatchScore | null;
}

export function toMatchResponse(match: Match): MatchResponse {
  return {
    id: match.id,
    homeTeam: match.homeTeam,
    homeTeamId: match.homeTeamId,
    awayTeam: match.awayTeam,
    awayTeamId: match.awayTeamId,
    kickoffAt: match.kickoffAt,
    status: match.status,
    score: match.score,
  };
}

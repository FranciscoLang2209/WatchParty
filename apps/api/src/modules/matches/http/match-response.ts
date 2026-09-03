import type { Match, MatchStatus } from '../domain/match.js';

export interface MatchResponse {
  id: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string;
  status: MatchStatus;
}

export function toMatchResponse(match: Match): MatchResponse {
  return {
    id: match.id,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    kickoffAt: match.kickoffAt,
    status: match.status,
  };
}

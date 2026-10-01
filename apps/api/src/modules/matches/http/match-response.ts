import type { Match, MatchStatus } from '../domain/match.js';

export interface MatchResponse {
  id: string;
  homeTeam: string;
  homeTeamId: string;
  awayTeam: string;
  awayTeamId: string;
  kickoffAt: string;
  status: MatchStatus;
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
  };
}

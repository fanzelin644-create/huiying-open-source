"""Generation scope keeps omitted storyboard segments out of paid stages."""
import copy


def scoped_episodes(episodes):
    return [{**ep, "segments": [s for s in ep.get("segments", []) if s.get("enabled", True)]}
            for ep in episodes]


def scope_artifacts(artifacts):
    result = copy.deepcopy(artifacts)
    storyboard = result.get("storyboard", {})
    episodes = scoped_episodes(storyboard.get("episodes", []))
    storyboard["episodes"] = episodes
    allowed = {s["segment_id"] for ep in episodes for s in ep["segments"]}
    for stage, key in (("reference_generation", "scenes"), ("video_generation", "clips")):
        if stage in result:
            result[stage][key] = [item for item in result[stage].get(key, []) if item.get("id") in allowed]
    return result

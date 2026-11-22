// 摄像头画面和推理共用同一张画布。匹配的时间戳与原始关键点一起交给工作站。
import { trackers } from '../tracking/trackers.js';
import { addFrameCost, setTarget } from '../quality.js';

export function startLive({ video, frame, onFrame, onError, onFrameMeasured }) {
  const context = frame.getContext('2d', { alpha: false });
  let lastTime = -1;
  let lastStamp = 0;
  let handGap = 0;
  let animation;
  const track = video.srcObject?.getVideoTracks()[0];
  setTarget(Math.min(30, track?.getSettings().frameRate || 30));

  function tick() {
    animation = requestAnimationFrame(tick);
    if (video.readyState < 2 || video.currentTime === lastTime) return;
    lastTime = video.currentTime;
    const now = Math.max(performance.now(), lastStamp + 0.01);
    lastStamp = now;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;

    let faceLandmarks, transformMatrix;
    let handLandmarks = [];
    try {
      if (frame.width !== width || frame.height !== height) {
        frame.width = width;
        frame.height = height;
      }
      context.drawImage(video, 0, 0, width, height);
      const face = trackers.face.detectForVideo(frame, now);
      faceLandmarks = face.faceLandmarks?.[0] ?? null;
      transformMatrix = face.facialTransformationMatrixes?.[0]?.data ?? null;
      if (trackers.hand && ++handGap >= 3) {
        handLandmarks = trackers.hand.detectForVideo(frame, now).landmarks ?? [];
        handGap = handLandmarks.length ? 3 : 0;
      }
    } catch (error) {
      onError(error);
      return;
    }
    const report = onFrame({ now, width, height, faceLandmarks, handLandmarks, transformMatrix });
    const costMs = performance.now() - now;
    addFrameCost(costMs);
    onFrameMeasured?.(now, costMs, report);
  }

  animation = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(animation);
}

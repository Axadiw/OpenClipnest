import { useNavigate } from 'react-router-dom';
import { CamerasSection } from '../CamerasSection';
import { CameraProfilesSection } from '../CameraProfilesSection';

export function CamerasTab() {
  const navigate = useNavigate();
  const onPickCamera = (camera: string) => {
    const params = new URLSearchParams();
    params.set('cameras', camera);
    navigate(`/grid?${params.toString()}`);
  };
  return (
    <>
      <CamerasSection onPickCamera={onPickCamera} />
      <CameraProfilesSection />
    </>
  );
}

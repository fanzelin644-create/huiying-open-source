import { Clapperboard } from 'lucide-react';

export default function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`director-mark ${small ? 'director-mark-small' : ''}`} aria-hidden="true"><Clapperboard size={small ? 18 : 23} strokeWidth={1.6} /></span>;
}

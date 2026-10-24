"""Stress temporal assembly with generated colors/tones, not real concert clips."""
import array, copy, math, shutil, sys, tempfile, threading, unittest, uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import engine

class FrameAlignmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=Path(tempfile.mkdtemp(prefix='compass-timeline-synthetic-'))
        cls.fixtures=[]
        for color,tone in [('red',440),('lime',660),('blue',880)]:
            p=cls.temp/(color+'.mp4')
            engine.ff(['-f','lavfi','-i',f'color={color}:s=180x320:r=30:d=24',
                       '-f','lavfi','-i',f'sine=frequency={tone}:sample_rate=48000:duration=24',
                       '-c:v','libx264','-preset','ultrafast','-threads','2','-c:a','aac','-t','24',str(p)])
            cls.fixtures.append(p)
    @classmethod
    def tearDownClass(cls):shutil.rmtree(cls.temp,ignore_errors=True)
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(dir=self.temp));self.cancel=threading.Event();self.clips=[]
        for i,fixture in enumerate(self.fixtures):
            p=self.root/(str(uuid.uuid4()).upper()+'.mov');shutil.copyfile(fixture,p)
            self.clips.append(engine.analyze(p,i+1,self.cancel))
    def tearDown(self):shutil.rmtree(self.root,ignore_errors=True)
    def test_irregular_40_cut_video_and_audio_share_every_boundary(self):
        s=engine.settings_from({'transitions':'cuts','targetSeconds':30})
        d=engine.direct(self.root,self.clips,s,self.cancel)
        template=d['plan']['moments'][0];moments=[]
        for i in range(40):
            m=copy.deepcopy(template);m.update(id=str(uuid.uuid4()).upper(),clipID=self.clips[i%3]['id'],start=.1,
                duration=[.373,.541,.267,.713,.423][i%5]);moments.append(m)
        d['plan']['moments']=moments
        d=engine.direct(self.root,self.clips,s,self.cancel,plan=d['plan'])
        shots=engine.frame_timeline(d['timeline'])
        output=engine.render(self.root,self.clips,d,self.cancel,lambda *_:None)
        raw=engine.ff(engine.inp(output)+['-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'])
        audio=array.array('f');audio.frombytes(raw)
        if sys.byteorder!='little':audio.byteswap()
        frames=engine.ff(engine.inp(output)+['-an','-vf','fps=30,scale=1:1,format=rgb24','-f','rawvideo','pipe:1'])
        for i,shot in enumerate(shots):
            mid=shot['at']+shot['moment']['duration']/2
            at=int(mid*30)*3;pixel=frames[at:at+3]
            self.assertEqual(max(range(3),key=lambda c:pixel[c]),i%3,f'Picture diverged at shot {i}')
            a=int((mid-.055)*16000);b=int((mid+.055)*16000)
            window=audio[a:b]
            frequency=sum(window[j]<=0<window[j+1] for j in range(len(window)-1))/((b-a)/16000)
            self.assertAlmostEqual(frequency,[440,660,880][i%3],delta=12,msg=f'Sound diverged at shot {i}')
    def test_sixty_second_full_reel_with_dissolves(self):
        s=engine.settings_from({'transitions':'dissolves','targetSeconds':60,'style':'cinematic'})
        d=engine.direct(self.root,self.clips,s,self.cancel)
        self.assertGreater(len(d['timeline']),10)
        output=engine.render(self.root,self.clips,d,self.cancel,lambda *_:None)
        metadata=engine.probe(output)
        self.assertAlmostEqual(float(metadata['format']['duration']),60,delta=.16)
        self.assertEqual([p.name for p in self.root.iterdir()],['reel.mp4'])

if __name__=='__main__':unittest.main(verbosity=2)

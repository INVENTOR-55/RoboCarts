import { createRobutek } from "./libs/robutek.js";
import * as colors from "./libs/colors.js";
import * as gpio from "gpio";
import { I2C1 } from "i2c";
import { VL53L0X } from "./libs/VL53L0X.js";
import { Servo } from "./libs/servo.js";
import { LED_WS2812B, SmartLed } from "smartled";

const robutek = createRobutek("V2");

I2C1.setup({ sda: robutek.Pins.SDA, scl: robutek.Pins.SCL, bitrate: 400000 });
const vl = new VL53L0X(I2C1);
const servo = new Servo(robutek.Pins.Servo2, 1, 4);
const ledStrip = new SmartLed(robutek.Pins.ILED, 7, LED_WS2812B);

let rainbowStep = 0;

const ZAKLADNI_RYCHLOST = 600;

function getRainbowColor(step: number): number {
    const speed = 0.1; 
    const r = Math.floor(Math.sin(step * speed + 0) * 127 + 128);
    const g = Math.floor(Math.sin(step * speed + 2) * 127 + 128);
    const b = Math.floor(Math.sin(step * speed + 4) * 127 + 128);
    
    return (r << 16) | (g << 8) | b;
}


function vykresliDuhu(): void {
    const aktualniBarva = getRainbowColor(rainbowStep);
    for (let i = 0; i < 7; i++) {
        ledStrip.set(i, aktualniBarva);
    }
    ledStrip.show();
    rainbowStep++;
}


async function zatoc(uhel: number): Promise<void> {
    robutek.setRamp(2500);   
    robutek.setSpeed(220);   
    
    vykresliDuhu();          
    await robutek.rotate(uhel); 
    
    robutek.setRamp(8000);   
    robutek.setSpeed(ZAKLADNI_RYCHLOST);   
    await sleep(20);         
}


async function jedKeStene(maxKalibrace = 0): Promise<void> {
    if (maxKalibrace > 0) {
        servo.write(600); 
    }
    
    robutek.setSpeed(ZAKLADNI_RYCHLOST); 
    robutek.move(0);       

    vykresliDuhu();
    await sleep(40);

    if (maxKalibrace > 0) {
        servo.write(60); 
        await sleep(60); 
        
        const mStart = await vl.read();
        let posledniVzdalenost = mStart.distance;

        let steering = 0; 
        let pocetMereni = 0;

        while (pocetMereni < maxKalibrace && posledniVzdalenost !== 20) {
            await sleep(40); 
            vykresliDuhu(); 

            const mCurrent = await vl.read();

            if (mCurrent.distance !== 20) {
                let rychlostPriblizeni = posledniVzdalenost - mCurrent.distance;
                const MAX_REALNA_ZMENA = 150; 

                if (Math.abs(rychlostPriblizeni) > MAX_REALNA_ZMENA) {
                    vykresliDuhu(); 
                } else {
                    steering = -rychlostPriblizeni * 0.0025; 

                    if (steering > 0.05) steering = 0.05;
                    if (steering < -0.05) steering = -0.05;

                    robutek.move(steering); 
                    posledniVzdalenost = mCurrent.distance;
                }
            }
            pocetMereni++;
        }

        servo.write(600); 
        await sleep(80); 
    }

    robutek.move(0); 
    
    let posledniVzdalenost = 0;
    let posledniCas = Date.now();
    
    while (true) {
        const mAhead = await vl.read();
        const aktualniCas = Date.now();
        vykresliDuhu(); 

        if (mAhead.distance !== 20) {
            if (posledniVzdalenost !== 0) {
                const dt = (aktualniCas - posledniCas) / 1000;
                const drahovyRozdil = posledniVzdalenost - mAhead.distance;
                const rychlostPriblizeni = drahovyRozdil / dt;
                const tolerance = 120; 
                
                if (mAhead.distance < 550) {
        
                    const detekovanProtijedouci = rychlostPriblizeni > (ZAKLADNI_RYCHLOST + tolerance);
                    const detekovanPomaly = rychlostPriblizeni < (ZAKLADNI_RYCHLOST - tolerance) && rychlostPriblizeni > 40;

                    if (detekovanProtijedouci || detekovanPomaly) {
                        await robutek.stop();
                        for (let i = 0; i < 20; i++) {
                            vykresliDuhu();
                            await sleep(40);
                        }
                        
                        robutek.setSpeed(ZAKLADNI_RYCHLOST);
                        robutek.move(0);
                        posledniVzdalenost = 0;
                        posledniCas = Date.now();
                        continue;
                    }
                }
            }

            posledniVzdalenost = mAhead.distance;
            posledniCas = aktualniCas;

            if (mAhead.distance < 340) {
                break; 
            }
        }
        await sleep(15); 
    }

    await robutek.stop();    
    await sleep(20);         
}

async function main(): Promise<void> {
    robutek.setRamp(8000);   
    servo.write(600);   
    await sleep(250);   

    while (true) {
        vykresliDuhu(); 
        const mBrana = await vl.read();
        if (mBrana.distance === 20 || mBrana.distance > 300) {
            break; 
        }
        await sleep(30); 
    }

    for (let i = 0; i < 25; i++) {
        vykresliDuhu(); 
        await sleep(0); 
    }

    robutek.setSpeed(1000);  
    robutek.move(0);        
    
    for (let i = 0; i < 14; i++) {
        vykresliDuhu();
        await sleep(50);
    }
    

    while (true) {
      
        await jedKeStene(12); 
        await zatoc(-90);      

        await jedKeStene(4);  
        await zatoc(-90); 
        
        await jedKeStene(0);  
        await zatoc(90);  
        
        await jedKeStene(0);  
        await zatoc(90);  
        
        await jedKeStene(0);  
        await zatoc(-120); 

        await jedKeStene(0);  
        await zatoc(-90); 
        
        await jedKeStene(12); 
        await zatoc(-100); 

        await jedKeStene(4);  
        await zatoc(-90); 
        
        await jedKeStene(4);  
        await zatoc(90);  
        
        await jedKeStene(0);  
        await zatoc(90);  
        
        await jedKeStene(0);  
        await zatoc(-90); 

        await jedKeStene(0);  
        await zatoc(-100); 

        await sleep(20); 
    }
}

main().catch(console.error);

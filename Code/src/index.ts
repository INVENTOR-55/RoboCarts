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

// Proměnná pro udržování fáze barevného přechodu
let rainbowStep = 0;

// Konstanta pro základní rychlost robota na rovinkách
const ZAKLADNI_RYCHLOST = 600;

// --- POMOCNÉ FUNKCE PRO LED PÁSEK ---

// Generuje jednu barvu pro celý pásek na základě globálního kroku (všechny LED naráz)
function getRainbowColor(step: number): number {
    const speed = 0.1; // Rychlost proměny barev
    
    const r = Math.floor(Math.sin(step * speed + 0) * 127 + 128);
    const g = Math.floor(Math.sin(step * speed + 2) * 127 + 128);
    const b = Math.floor(Math.sin(step * speed + 4) * 127 + 128);
    
    // Sloučení R, G, B složek do jednoho 24-bitového čísla (0xRRGGBB)
    return (r << 16) | (g << 8) | b;
}

// Funkce, která nastaví aktuální barvu z přechodu na VŠECHNY diody
function vykresliDuhu(): void {
    const aktualniBarva = getRainbowColor(rainbowStep);
    for (let i = 0; i < 7; i++) {
        ledStrip.set(i, aktualniBarva);
    }
    ledStrip.show();
    rainbowStep++;
}

// --- PŘESNÉ ZATÁČENÍ BEZ PROKLUZU ---
async function zatoc(uhel: number): Promise<void> {
    robutek.setRamp(2500);   
    robutek.setSpeed(220);   
    
    vykresliDuhu();          
    await robutek.rotate(uhel); 
    
    robutek.setRamp(8000);   
    robutek.setSpeed(ZAKLADNI_RYCHLOST);   
    await sleep(20);         
}

// --- JÍZDA VPŘED S DETEKCÍ PROTIHRÁČE VIA RELATIVNÍ RYCHLOST ---
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

    // Znovu se ujistíme, že jedeme rovně na cíl
    robutek.move(0); 
    
    let posledniVzdalenost = 0;
    let posledniCas = Date.now();
    
    while (true) {
        const mAhead = await vl.read();
        const aktualniCas = Date.now();
        vykresliDuhu(); 

        if (mAhead.distance !== 20) {
            if (posledniVzdalenost !== 0) {
                // Spočítáme čas od minulého měření v sekundách (cca 0.015 s)
                const dt = (aktualniCas - posledniCas) / 1000;
                
                // Rozdíl vzdáleností v mm (kladné číslo = přibližování)
                const drahovyRozdil = posledniVzdalenost - mAhead.distance;
                
                // Výpočet relativní rychlosti v mm/s
                const rychlostPriblizeni = drahovyRozdil / dt;

                // Tolerance pro šum senzoru (v mm/s)
                const tolerance = 120; 

                // Protihráče řešíme, až když je blíž než 55 cm (prevence falešných detekcí v dálce)
                if (mAhead.distance < 550) {
                    
                    // SCÉNÁŘ A: Objekt se blíží výrazně rychleji, než robot vůbec jede (jede proti nám)
                    // SCÉNÁŘ B: Objekt je blízko, ale přibližujeme se k němu podezřele pomalu (dojíždíme ho, nebo stojí nakoso)
                    const detekovanProtijedouci = rychlostPriblizeni > (ZAKLADNI_RYCHLOST + tolerance);
                    const detekovanPomaly = rychlostPriblizeni < (ZAKLADNI_RYCHLOST - tolerance) && rychlostPriblizeni > 40;

                    if (detekovanProtijedouci || detekovanPomaly) {
                        // KRIZE: Je to protihráč. Zastavíme a počkáme, až odjede
                        await robutek.stop();
                        
                        // Počkáme (duha během čekání plynule běží)
                        for (let i = 0; i < 20; i++) {
                            vykresliDuhu();
                            await sleep(40); // Celkem cca 800ms pauza na trati
                        }
                        
                        // Po pauze se znova rozjedeme a resetujeme paměť senzoru
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

            // Standardní detekce pevné stěny pro ukončení rovinky (vzdálenost < 34 cm)
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

    // Čekání na startovací bránu
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

    // --- TAKTICKÁ PAUZA (1000 ms) ---
    // Závora se zvedla, ale my schválně sekundu stojíme.
    // Ostatní roboti vystartují a uvolní nám celou trať.
    for (let i = 0; i < 25; i++) {
        vykresliDuhu(); // Efekt duhy běží, robot vizuálně „žije“
        await sleep(0); // 25 * 40ms = 1000ms
    }

    // --- RAKETOVÝ START DO VOLNÉ TRATI ---
    robutek.setSpeed(1000);  
    robutek.move(0);        
    
    for (let i = 0; i < 14; i++) {
        vykresliDuhu();
        await sleep(50);
    }
    // ----------------------------------------------

    while (true) {
        // --- 1. POLOVINA TRATI ---
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
        
        // --- 2. POLOVINA TRATI ---
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
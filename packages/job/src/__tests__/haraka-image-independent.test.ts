import {findHarakaImage,loadTokyoHarakaCards} from '../lib/haraka-card-images';
import {buildTokyoPreparedCards} from '../lib/tokyo-normal-cards';

const product={id:'test-source',franchise:'Pokemon',product_type:'psa',name:'ピカチュウ(マスターボールミラー)',model_number:'025/165',price_high:12300,image_url:'https://slab.invalid/a.jpg'};
const row=(name:string)=>({id:'db-test',store:'manman-akihabara',franchise:'Pokemon',grade:'PSA10',card_name:name,list_no:'025/165',image_url:'https://www.pokemon-card.com/assets/images/test.jpg',alt_image_url:null}) as any;
test('independent explicit variant remains review-only and never becomes prepared image',()=>{
 for(const name of ['ピカチュウ(モンスターボールミラー)','ピカチュウ']){
  expect(findHarakaImage(product,[row(name)])).toMatchObject({status:'ambiguous',imageUrl:null});
  expect(buildTokyoPreparedCards('test',{snapshot:{store:'manman-akihabara',business_date:'2026-09-07'},products:[product]} as any,[],[row(name)])[0]).toMatchObject({image_url:null,alt_image_url:null,price_high:12300});
 }
 expect(findHarakaImage(product,[row(product.name)]).status).toBe('matched');
 expect(findHarakaImage(product,[{...row(product.name),store:'manman'}]).status).toBe('missing');
});
test('exact full page boundary loads final empty page with fixed Tokyo filter',async()=>{
 const calls:number[][]=[];
 const query={
  select:()=>query,
  eq:(key:string,value:string)=>{expect([key,value]).toEqual(['store','manman-akihabara']);return query;},
  order:(key:string)=>{expect(key).toBe('id');return query;},
  range:async(from:number,to:number)=>{calls.push([from,to]);return{data:from<2000?Array.from({length:1000},(_,i)=>({...row('ピカチュウ'),id:String(from+i)})):[],error:null};},
 };
 const db={from:(table:string)=>{expect(table).toBe('db_card');return query;}};
 const loaded=await loadTokyoHarakaCards(db as any);
 expect(loaded).toHaveLength(2000);expect(new Set(loaded.map(x=>x.id)).size).toBe(2000);expect(calls).toEqual([[0,999],[1000,1999],[2000,2999]]);
});

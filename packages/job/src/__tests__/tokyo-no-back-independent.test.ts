import sharp from 'sharp';
import {prepareTokyoRenderableCards} from '../jobs/generate';
import {composePage} from '../lib/image-composer';
import {downloadImagesWithConcurrency} from '../lib/google-drive';
jest.mock('../lib/google-drive',()=>({downloadImagesWithConcurrency:jest.fn()}));

test('actual decoded image preflight omits missing products and native composer fills only unused slots without prices',async()=>{
 const valid=await sharp({create:{width:30,height:40,channels:3,background:'#008800'}}).png().toBuffer();
 const truncated=valid.subarray(0,valid.length-20);
 await sharp(truncated).metadata();
 await expect(sharp(truncated).stats()).rejects.toThrow();
 const cards=['good','null','corrupt'].map(id=>({id,image_url:id==='null'?null:'https://offline.invalid/'+id,alt_image_url:null,price_high:12300,price_low:12300,tag:'PSA10'})) as any;
 jest.mocked(downloadImagesWithConcurrency).mockResolvedValueOnce([valid,null,truncated]);
 const checked=await prepareTokyoRenderableCards(cards);
 expect(checked.cards.map(x=>x.id)).toEqual(['good']);expect(cards).toHaveLength(3);
 const background=await sharp({create:{width:500,height:420,channels:3,background:'#fff'}}).png().toBuffer();
 const back=await sharp({create:{width:30,height:40,channels:3,background:'#0000cc'}}).png().toBuffer();
 const params={templateBuffer:background,cardBackBuffer:back,cards:checked.cards,layout:{startX:10,priceStartX:10,colWidth:220,cardWidth:120,cardHeight:180,priceBoxWidth:180,priceBoxHeight:35,dateX:200,dateY:360,rows:[{cardY:10,priceHighY:210,priceLowY:250}]} as any,assetProfile:{grid_cols:2,price_format:'¥{price}',font_family:'Arial'} as any,cardImageBuffers:checked.buffers,dateText:'09/08',skipPriceLow:true,totalSlots:2,requireCardImages:true};
 const png=await composePage(params);
 const pixels=await sharp(png).removeAlpha().raw().toBuffer();
 const pixel=(x:number,y:number)=>[...pixels.subarray((y*500+x)*3,(y*500+x)*3+3)];
 expect(pixel(20,20)).toEqual([0,136,0]);expect(pixel(240,20)).toEqual([0,0,204]);
 expect(pixel(240,220)).toEqual([255,255,255]);
 const emptyPrices=await sharp(png).extract({left:230,top:210,width:180,height:75}).removeAlpha().raw().toBuffer();
 expect([...emptyPrices].every(value=>value===255)).toBe(true);
 await expect(composePage({...params,cardImageBuffers:new Map()})).rejects.toThrow('Card image is required');
 await expect(composePage({...params,cardImageBuffers:new Map([['good',truncated]])})).rejects.toThrow('cannot be decoded');
});
